import copy
import json
import math
import os
import io
import chess.pgn
import threading
import time
import uuid
from dotenv import load_dotenv
import random
import sqlite3
from datetime import datetime, timezone
import chess
import requests
from flask import Flask, jsonify, request, Response
from flask_cors import CORS
from flask_socketio import SocketIO
import chess.engine
from led_serial import LedBoard


BASE_DIR = os.path.dirname(os.path.abspath(__file__))


STOCKFISH_PATH = os.path.join(
    BASE_DIR,
    "Stockfish_Engine",
    "stockfish",
    "stockfish.exe",
)


print("Stockfish path:", STOCKFISH_PATH)
print("Stockfish exists:", os.path.exists(STOCKFISH_PATH))


EVAL_DEPTH = 12


engine = None
engine_lock = threading.Lock()


def get_engine():
    global engine

    with engine_lock:
        if engine is None:
            engine = chess.engine.SimpleEngine.popen_uci(
                STOCKFISH_PATH
            )
            engine.configure({"Threads": 2, "Hash": 128})

        return engine


# =========================================================
# Configuration
# =========================================================

DB_PATH = os.path.join(BASE_DIR, "hallgrid_games.db")

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
)

load_dotenv(override=True)

LICHESS_TOKEN = os.getenv("LICHESS_TOKEN")

BASE = "https://lichess.org"
DEFAULT_TIME_UNIT = os.getenv("TIME_LIMIT_UNIT", "minutes")

lock = threading.RLock()
startup_lock = threading.Lock()
events_ready = threading.Event()
event_thread = None

MY_ACCOUNT_ID = None
clients = set()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS games (
            game_id TEXT PRIMARY KEY,
            mode TEXT NOT NULL,
            player_color TEXT,
            bot_elo INTEGER,
            initial_fen TEXT NOT NULL,
            moves_json TEXT NOT NULL DEFAULT '[]',
            sans_json TEXT NOT NULL DEFAULT '[]',
            status TEXT,
            winner TEXT,
            pgn TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)

    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(games)").fetchall()
    }

    if "opponent_username" not in columns:
        conn.execute(
            "ALTER TABLE games ADD COLUMN opponent_username TEXT"
        )

    conn.commit()
    conn.close()


init_db()


def led_show_game_highlight(
    last_move=None,
    pending_move=None,
):
    last_from = last_move.get("from") if last_move else None
    last_to = last_move.get("to") if last_move else None

    pending_from = pending_move.get("from") if pending_move else None
    pending_to = pending_move.get("to") if pending_move else None

    led_safe(
        "game_highlight",
        last_from,
        last_to,
        pending_from,
        pending_to,
    )


def upsert_game(
    game_id,
    mode,
    player_color,
    bot_elo,
    initial_fen,
    moves,
    sans,
    status,
    winner,
    pgn=None,
    opponent_username=None,
):
    now = datetime.now(timezone.utc).isoformat()

    conn = get_db()

    conn.execute(
        """
        INSERT INTO games (
            game_id, mode, player_color, bot_elo, opponent_username,
            initial_fen, moves_json, sans_json, status, winner, pgn,
            created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(game_id) DO UPDATE SET
            player_color = excluded.player_color,
            bot_elo = excluded.bot_elo,
            opponent_username = COALESCE(
                excluded.opponent_username,
                games.opponent_username
            ),
            moves_json = excluded.moves_json,
            sans_json = excluded.sans_json,
            status = excluded.status,
            winner = excluded.winner,
            pgn = excluded.pgn,
            updated_at = excluded.updated_at
        """,
        (
            game_id,
            mode,
            player_color,
            bot_elo,
            opponent_username,
            initial_fen,
            json.dumps(moves),
            json.dumps(sans),
            status,
            winner,
            pgn,
            now,
            now,
        ),
    )

    conn.commit()
    conn.close()

def get_saved_game(game_id):
    conn = get_db()

    row = conn.execute(
        "SELECT * FROM games WHERE game_id = ?",
        (game_id,),
    ).fetchone()

    conn.close()

    if row is None:
        return None

    return {
        "gameId": row["game_id"],
        "mode": row["mode"],
        "playerColor": row["player_color"],
        "botElo": row["bot_elo"],
        "initialFen": row["initial_fen"],
        "moves": json.loads(row["moves_json"]),
        "sans": json.loads(row["sans_json"]),
        "status": row["status"],
        "winner": row["winner"],
        "pgn": row["pgn"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def headers():
    return {
        "Authorization": f"Bearer {LICHESS_TOKEN}",
        "Accept": "application/x-ndjson",
    }


def background(fn, *args):
    return socketio.start_background_task(fn, *args)


def api_error(response):
    """
    Safely extract a readable error message from a Lichess response.
    Never assumes the response body is JSON.
    """
    try:
        data = response.json()
    except Exception:
        text = (response.text or "").strip()

        if text:
            return text[:500]

        return (
            f"Lichess returned HTTP {response.status_code} "
            "with no readable error body."
        )

    if isinstance(data, dict):
        message = (
            data.get("error")
            or data.get("message")
            or data.get("detail")
        )

        if message:
            return str(message)

        return str(data)[:500]

    return str(data)[:500]


def move_info(board, move):
    return {
        "uci": move.uci(),
        "from": chess.square_name(move.from_square),
        "to": chess.square_name(move.to_square),
        "promotion": (
            chess.piece_symbol(move.promotion)
            if move.promotion else None
        ),
        "san": board.san(move),
    }


def analyse_and_publish_eval(fen, game_id, mode="casual"):
    try:
        board = chess.Board(fen)

        eng = get_engine()

        with engine_lock:
            info = eng.analyse(
                board,
                chess.engine.Limit(depth=EVAL_DEPTH),
            )

        score = info["score"].relative

        eval_payload = {
            "gameId": game_id,
            "mode": mode,
            "fen": fen,
            "depth": EVAL_DEPTH,
        }

        if score.is_mate():
            eval_payload["mate"] = score.mate()
            eval_payload["evalCp"] = None
        else:
            eval_payload["mate"] = None
            eval_payload["evalCp"] = score.score()

        best = info.get("pv")

        if best:
            eval_payload["bestMove"] = best[0].uci()

        socketio.emit("eval_update", eval_payload)

    except Exception as exc:
        print("Eval analysis error:", exc)


LED_PORT = "COM3"  # CHANGE THIS to your actual Pico port

try:
    led = LedBoard(LED_PORT)
    print("LED board connected:", LED_PORT)
except Exception as exc:
    led = None
    print("LED board not connected:", exc)


def led_safe(function_name, *args):
    if led is None:
        return

    try:
        getattr(led, function_name)(*args)
    except Exception as exc:
        print("LED command failed:", function_name, exc)


def led_game_over(result):
    led_safe("end", result)



def casual_result_to_led(winner):
    if winner == "white":
        return "casual_white_win"

    if winner == "black":
        return "casual_black_win"

    return "draw"

CASUAL = {
    "game_id": None,
    "phase": "idle",
    "board": chess.Board(),
    "moves": [],
    "sans": [],
    "initial_fen": chess.STARTING_FEN,
    "time_limit_seconds": 300,
    "increment_seconds": 0,
    "white_ms": 300_000,
    "black_ms": 300_000,
    "turn_started_at": None,
    "status": None,
    "winner": None,
    "error": None,
    "last_confirmed_placement": None,
}


BOT = {
    "game_id": None,
    # idle | waiting_for_pieces | your_turn | bot_thinking |
    # replicate_bot_move | game_over
    "phase": "idle",
    "player_color": "white",
    "bot_color": "black",
    "bot_elo": 1500,
    "board": chess.Board(),
    "moves": [],
    "sans": [],
    "initial_fen": chess.STARTING_FEN,
    "pending_bot_move": None,
    "last_confirmed_placement": None,
    "status": None,
    "winner": None,
    "error": None,
}


def lichess_initial_board_locked():
    return chess.Board(S["initial_fen"])


def bot_skill_from_elo(elo):
    """Map 800-3000 ELO to Stockfish Skill Level 0-20."""
    elo = max(800, min(3000, int(elo)))
    return max(0, min(20, int((elo - 800) / (3000 - 800) * 20)))


def bot_snapshot():
    board = BOT["board"]

    return {
        "gameId": BOT["game_id"],
        "mode": "bot",
        "phase": BOT["phase"],
        "fen": board.fen(),
        "displayFen": board.fen(),
        "initialFen": BOT["initial_fen"],
        "turn": "white" if board.turn else "black",
        "playerColor": BOT["player_color"],
        "botColor": BOT["bot_color"],
        "botElo": BOT["bot_elo"],
        "moves": list(BOT["moves"]),
        "sans": list(BOT["sans"]),
        "pendingBotMove": BOT["pending_bot_move"],
        "status": BOT["status"],
        "winner": BOT["winner"],
        "error": BOT["error"],
    }


def publish_bot(event="bot_session", extra=None, to=None):
    payload = bot_snapshot()

    if extra:
        payload.update(extra)

    socketio.emit(event, payload, to=to)


def finish_bot_locked():
    board = BOT["board"]
    outcome = board.outcome(claim_draw=True)

    if outcome is None:
        return None

    BOT["phase"] = "game_over"
    BOT["status"] = outcome.termination.name.lower()

    if outcome.winner is chess.WHITE:
        BOT["winner"] = "white"
    elif outcome.winner is chess.BLACK:
        BOT["winner"] = "black"
    else:
        BOT["winner"] = None

    return {
        "status": BOT["status"],
        "winner": BOT["winner"],
    }


def get_bot_move(fen, bot_elo):
    board = chess.Board(fen)
    eng = get_engine()

    print("BOT: using engine at", STOCKFISH_PATH)

    with engine_lock:
        eng.configure({"Skill Level": bot_skill_from_elo(bot_elo)})
        result = eng.analyse(
            board,
            chess.engine.Limit(time=0.35),
        )

    print("BOT: raw result:", result.get("pv"))

    return result


def casual_snapshot():
    board = CASUAL["board"]

    return {
        "gameId": CASUAL["game_id"],
        "mode": "casual",
        "phase": CASUAL["phase"],
        "fen": board.fen(),
        "displayFen": board.fen(),
        "initialFen": CASUAL["initial_fen"],
        "turn": "white" if board.turn else "black",
        "playerColor": CASUAL.get("player_color", "white"),
        "moves": list(CASUAL["moves"]),
        "sans": list(CASUAL["sans"]),
        "whiteTimeMs": CASUAL["white_ms"],
        "blackTimeMs": CASUAL["black_ms"],
        "timeLimitSeconds": CASUAL["time_limit_seconds"],
        "incrementSeconds": CASUAL["increment_seconds"],
        "status": CASUAL["status"],
        "winner": CASUAL["winner"],
        "error": CASUAL["error"],
    }

def publish_casual(event="casual_session", extra=None, to=None):
    payload = casual_snapshot()

    if extra:
        payload.update(extra)

    socketio.emit(event, payload, to=to)


def finish_casual_locked():
    board = CASUAL["board"]
    outcome = board.outcome(claim_draw=True)

    if outcome is None:
        return None

    CASUAL["phase"] = "game_over"
    CASUAL["status"] = outcome.termination.name.lower()

    if outcome.winner is chess.WHITE:
        CASUAL["winner"] = "white"
    elif outcome.winner is chess.BLACK:
        CASUAL["winner"] = "black"
    else:
        CASUAL["winner"] = None

    CASUAL["turn_started_at"] = None

    return {
        "status": CASUAL["status"],
        "winner": CASUAL["winner"],
    }


def run_casual_clock():
    while True:
        time.sleep(0.1)

        with lock:
            if CASUAL["phase"] != "your_turn":
                continue

            if CASUAL["turn_started_at"] is None:
                continue

            now = time.time()
            elapsed_ms = max(
                0,
                int((now - CASUAL["turn_started_at"]) * 1000),
            )

            board = CASUAL["board"]
            active_color = "white" if board.turn else "black"

            if active_color == "white":
                CASUAL["white_ms"] = max(
                    0,
                    CASUAL["white_ms"] - elapsed_ms,
                )
                remaining = CASUAL["white_ms"]
            else:
                CASUAL["black_ms"] = max(
                    0,
                    CASUAL["black_ms"] - elapsed_ms,
                )
                remaining = CASUAL["black_ms"]

            CASUAL["turn_started_at"] = now

            if remaining <= 0:
                CASUAL["phase"] = "game_over"
                CASUAL["status"] = "timeout"
                CASUAL["winner"] = (
                    "black" if active_color == "white" else "white"
                )
                CASUAL["turn_started_at"] = None

                socketio.emit(
                    "casual_game_over",
                    casual_snapshot(),
                )

                led_game_over(
                    casual_result_to_led(CASUAL["winner"])
                )

                background(
                    save_finished_casual_game,
                    CASUAL["game_id"],
                )

                continue

            clock_payload = {
                "gameId": CASUAL["game_id"],
                "whiteTimeMs": CASUAL["white_ms"],
                "blackTimeMs": CASUAL["black_ms"],
                "runningColor": active_color,
            }

        socketio.emit("casual_clock", clock_payload)


# =========================================================
# Lichess smart-board game state
# =========================================================

S = {
    "request_id": None,
    "seek_running": False,
    "game_id": None,
    "phase": "idle",
    "my_color": None,
    "metadata": {},
    "initial_fen": chess.STARTING_FEN,
    "display_board": chess.Board(),
    "server_board": chess.Board(),
    "server_moves": [],
    "pending_opponent": None,
    "pending_submission": None,
    "stream_connected": False,
    "status": None,
    "winner": None,
    "clock": {},
    "error": None,
}


# eval_related
# eval_related

eval_session = {
    "active": False,
    "phase": "idle",
    "side_to_move": "white",
    "position_version": 0,
    "cancel_requested": False,
    "lock": threading.Lock(),
}


def eval_emit_state(message, phase=None):
    payload = {
        "phase": phase or eval_session["phase"],
        "message": message,
        "side_to_move": eval_session["side_to_move"],
    }

    socketio.emit("eval_state", payload)



# =========================================================
# Scan Mode (Camera & LED Occupancy Diagnostic)
# =========================================================

scan_session = {
    "active": False,
    "phase": "idle",  # idle | scanning | live_occupancy
    "occupied_squares": [],
}


@socketio.on("scan_start")
def handle_scan_start(data=None):
    with lock:
        scan_session["active"] = True
        scan_session["phase"] = "scanning"
        scan_session["occupied_squares"] = []

    led_safe("loading", "scan_wave", True)
    socketio.emit(
        "scan_started",
        {
            "phase": "scanning",
            "message": "Scanning board...",
            "occupiedSquares": [],
        },
    )


@socketio.on("scan_stop")
def handle_scan_stop(data=None):
    with lock:
        scan_session["active"] = False
        scan_session["phase"] = "idle"
        scan_session["occupied_squares"] = []

    led_safe("off")
    socketio.emit(
        "scan_stopped",
        {
            "phase": "idle",
            "message": "Scan stopped.",
            "occupiedSquares": [],
        },
    )


@socketio.on("scan_occupancy")
def handle_scan_occupancy(data=None):
    data = data or {}
    squares = list(data.get("occupiedSquares") or [])

    with lock:
        if not scan_session["active"]:
            return
        scan_session["phase"] = "live_occupancy"
        scan_session["occupied_squares"] = squares

    led_safe("scan_occupancy", squares)
    socketio.emit(
        "scan_occupancy",
        {
            "phase": "live_occupancy",
            "occupiedSquares": squares,
            "message": (
                f"Occupied ({len(squares)}): {', '.join(squares)}"
                if squares
                else "Board clear (0 pieces detected)."
            ),
        },
    )


@socketio.on("eval_start")
def handle_eval_start(data):
    data = data or {}

    side_to_move = data.get("side_to_move", "white")

    if side_to_move not in {"white", "black"}:
        side_to_move = "white"

    with eval_session["lock"]:
        eval_session["active"] = True
        eval_session["phase"] = "waiting_for_position"
        eval_session["side_to_move"] = side_to_move
        eval_session["position_version"] += 1
        eval_session["cancel_requested"] = False

    eval_emit_state(
        "Board opening. Send a position when ready.",
        "waiting_for_position",
    )

    led_safe("loading", "curtain")


@socketio.on("eval_end")
def handle_eval_end():
    with eval_session["lock"]:
        eval_session["active"] = False
        eval_session["phase"] = "idle"
        eval_session["cancel_requested"] = True

    led_safe("off")

    eval_emit_state(
        "Evaluation ended.",
        "idle",
    )


@socketio.on("update_eval_board")
def handle_update_eval_board(data):
    data = data or {}
    fen = data.get("fen")

    if not isinstance(fen, str):
        eval_emit_state(
            "Missing FEN. Send a complete FEN.",
            "waiting_for_position",
        )
        return

    try:
        board = chess.Board(fen)
    except Exception as exc:
        eval_emit_state(
            f"Invalid FEN: {exc}",
            "waiting_for_position",
        )
        return

    white_king = board.piece_at(chess.E1)
    black_king = board.piece_at(chess.E8)

    kings_present = (
        white_king is not None
        and white_king.piece_type == chess.KING
        and white_king.color == chess.WHITE
        and black_king is not None
        and black_king.piece_type == chess.KING
        and black_king.color == chess.BLACK
    )

    if not kings_present:
        eval_emit_state(
            "Place both kings before evaluating.",
            "waiting_for_position",
        )
        return

    with eval_session["lock"]:
        if not eval_session["active"]:
            return

        eval_session["phase"] = "evaluating"
        eval_session["position_version"] += 1

        version = eval_session["position_version"]
        side_to_move = eval_session["side_to_move"]

    eval_emit_state(
        "Reading board and evaluating…",
        "evaluating",
    )

    led_safe("loading", "curtain")

    background(
        run_eval_position,
        fen,
        side_to_move,
        version,
    )


def run_eval_position(fen, side_to_move, version):
    try:
        board = chess.Board(fen)
        engine = get_engine()

        with engine_lock:
            info = engine.analyse(
                board,
                chess.engine.Limit(depth=EVAL_DEPTH),
            )

        with eval_session["lock"]:
            still_current = (
                eval_session["active"]
                and eval_session["position_version"] == version
            )

        if not still_current:
            return

        score = info["score"].white()

        if score.is_mate():
            evaluation = None
            mate = score.mate()
        else:
            evaluation = score.score() / 100.0
            mate = None

        best_move = None
        principal_variation = info.get("pv")

        if principal_variation:
            best_move = principal_variation[0].uci()

        socketio.emit(
            "eval_ready",
            {
                "evaluation": evaluation,
                "mate": mate,
                "bestMove": best_move,
                "fen": fen,
                "sideToMove": side_to_move,
            },
        )

        eval_emit_state(
            "Evaluation ready.",
            "eval_ready",
        )

        led_safe(
            "eval_horizon",
            evaluation,
            mate,
        )

    except Exception as exc:
        print("Eval error:", exc)

        eval_emit_state(
            "Could not evaluate the position.",
            "waiting_for_position",
        )








# =========================================================
# Puzzle Rush
# =========================================================

RUSH_TOTAL_PUZZLES = 8
RUSH_MAX_STRIKES = 3

# Exact VIBGYOR mapping:
# V = Pawn, B = Rook, G = Knight, Y = Bishop, O = Queen, R = King
RUSH_PIECE_ORDER = ["P", "R", "N", "B", "Q", "K"]
RUSH_PIECE_COLOURS = {
    "P": (148, 0, 211),  # Violet
    "R": (0, 0, 255),    # Blue
    "N": (0, 200, 0),    # Green
    "B": (255, 200, 0),  # Yellow
    "Q": (255, 100, 0),  # Orange
    "K": (255, 0, 0),    # Red
}

RUSH_PUZZLES = [
    {
        "fen": "r3r3/pp1R2pk/2p2pNp/5P2/2B2Q2/8/P1P2qPP/4b2K w - - 0 11",
        "moves": ["d7g7", "h7g7", "f4c7", "e8e7", "c7e7"],
    },
    {
        "fen": "1r2k1r1/pbppnp1p/1b3P2/8/Q7/B1PB1q2/P4PPP/3R2K1 w - - 0 1",
        "moves": ["a4d7", "e8d7", "d3f5", "d7e8", "f5d7", "e8f8", "a3e7"],
    },
    {
        "fen": "1n3rk1/1b1p1p2/2pbpB1Q/4P3/2pq2Pp/2N4P/2P2P2/2KR4 b - - 1 1",
        "moves": ["d6a3", "c1b1", "d4b6", "c3b5", "b6b5", "b1a2", "b5b2"],
    },
    {
        "fen": "r2q1rk1/ppp2ppR/2b2n2/8/3p4/2PQPNP1/PPB2PP1/R3K3 b Q - 0 1",
        "moves": ["c6e4", "d3e4", "f6e4"],
    },
    {
        "fen": "r1b4r/pppk2pp/3p4/2b5/8/3B4/P1qB2PP/4RR1K w - - 1 2",
        "moves": ["d3b5", "c7c6", "f1f7", "d7d8", "d2g5"],
    },
    {
        "fen": "5r1k/1bp3pp/p1n4q/2PQ1pN1/1p3P2/8/P3r1PP/3R1RK1 w - - 0 2",
        "moves": ["g5f7", "f8f7", "d5d8", "c6d8", "d1d8", "e2e8", "d8e8", "f7f8", "e8f8"],
    },
    {
        "fen": "r1bqk2r/ppp1bp1p/2n4n/3p1N2/4PpQ1/2N3P1/PPPP3P/R1B1KB1R w KQkq - 1 2",
        "moves": ["g4g7", "h8g8", "g7h6", "c8f5", "e4f5"],
    },
    {
        "fen": "3rk1nr/1pq1bpp1/p1p1p1n1/4P3/2BPN1Q1/7P/PP1B1PP1/2R1K2R w Kk - 1 2",
        "moves": ["c4e6", "g8h6", "e6f7"],
    },
]

rush_session = {
    "active": False,
    "phase": "idle",
    "puzzle_id": None,
    "player_color": "white",
    "board": None,
    "solution_moves": [],
    "solution_index": 0,
    "pending_opponent_move": None,
    "setup_groups": [],
    "setup_group_index": 0,
    "puzzles_solved": 0,
    "strikes": 0,
    "current_puzzle": 0,
    "results": ["unplayed"] * RUSH_TOTAL_PUZZLES,
    "run_id": 0,
}


def rush_led_square(square, player_color=None):
    """Rotate square 180 degrees for physical LEDs when playing as Black."""
    color = player_color or rush_session.get("player_color", "white")
    if color != "black":
        return square
    sq = chess.parse_square(square.strip().lower())
    flipped = chess.square(7 - chess.square_file(sq), 7 - chess.square_rank(sq))
    return chess.square_name(flipped)


def rush_led_squares(squares, player_color=None):
    return [rush_led_square(sq, player_color) for sq in squares]


def rush_current_setup_group():
    if rush_session["phase"] not in {
        "placing_white_pieces",
        "placing_black_pieces",
    }:
        return None
    idx = rush_session["setup_group_index"]
    if idx >= len(rush_session["setup_groups"]):
        return None
    return rush_session["setup_groups"][idx]


def rush_state_message():
    phase = rush_session["phase"]
    group = rush_current_setup_group()
    side_label = rush_session.get("player_color", "white").title()

    if phase in {"placing_white_pieces", "placing_black_pieces"} and group:
        return (
            f"[{side_label}] Place {group['colour'].title()} {group['pieceName']}s "
            f"on {', '.join(group['squares'])}."
        )
    messages = {
        "scanning_initial_board": "Scanning board...",
        "waiting_for_empty_board": "Remove all pieces from the board.",
        "loading_puzzle": f"Loading puzzle (Playing as {side_label})...",
        "waiting_for_user_move": f"Playing as {side_label} · Find the best move.",
        "waiting_for_opponent_move": f"Playing as {side_label} · Play the highlighted opponent move.",
        "showing_feedback": "Checking move...",
        "showing_score": "Puzzle Rush score.",
        "rush_complete": "Puzzle Rush complete.",
    }
    return messages.get(phase, "Puzzle Rush ended.")


def rush_snapshot():
    board = rush_session["board"]
    group = rush_current_setup_group()
    return {
        "active": rush_session["active"],
        "phase": rush_session["phase"],
        "puzzleId": rush_session["puzzle_id"],
        "playerColor": rush_session["player_color"],
        "currentPuzzle": rush_session["current_puzzle"],
        "puzzleNumber": min(
            rush_session["current_puzzle"] + 1,
            RUSH_TOTAL_PUZZLES,
        ),
        "totalPuzzles": RUSH_TOTAL_PUZZLES,
        "puzzlesSolved": rush_session["puzzles_solved"],
        "strikes": rush_session["strikes"],
        "maxStrikes": RUSH_MAX_STRIKES,
        "results": list(rush_session["results"]),
        "fen": board.fen() if board else None,
        "turn": ("white" if board.turn else "black") if board else None,
        "setupSquares": list(group["squares"]) if group else [],
        "setupSquare": ", ".join(group["squares"]) if group else None,
        "setupPiece": group["piece"] if group else None,
        "setupColor": group["colour"] if group else None,
        "pendingOpponentMove": rush_session["pending_opponent_move"],
        "message": rush_state_message(),
    }


def publish_rush(event="rush_state", extra=None, to=None):
    payload = rush_snapshot()
    if extra:
        payload.update(extra)
    socketio.emit(event, payload, to=to)


def rush_build_setup_groups(board):
    piece_names = {
        "P": "Pawn",
        "R": "Rook",
        "N": "Knight",
        "B": "Bishop",
        "Q": "Queen",
        "K": "King",
    }
    groups = []
    for colour_name, chess_colour in (("white", chess.WHITE), ("black", chess.BLACK)):
        for symbol in RUSH_PIECE_ORDER:
            squares = []
            for sq, piece in board.piece_map().items():
                if piece.color == chess_colour and piece.symbol().upper() == symbol:
                    squares.append(chess.square_name(sq))
            if squares:
                squares.sort()
                groups.append({
                    "colour": colour_name,
                    "piece": symbol if chess_colour == chess.WHITE else symbol.lower(),
                    "pieceName": piece_names[symbol],
                    "squares": squares,
                })
    return groups


def rush_emit_current_piece_prompt():
    with lock:
        if not rush_session["active"]:
            return
        group = rush_current_setup_group()
        if group is None:
            return
        led_sqs = rush_led_squares(group["squares"])
        piece = group["piece"]
        rgb = RUSH_PIECE_COLOURS[piece.upper()]

    led_safe("rush_piece_prompt", led_sqs, rgb)
    publish_rush("rush_piece_prompt")


def rush_start_puzzle(run_id):
    with lock:
        if not rush_session["active"] or rush_session["run_id"] != run_id:
            return
        idx = rush_session["current_puzzle"]
        puzzle = RUSH_PUZZLES[idx]
        board = chess.Board(puzzle["fen"])
        groups = rush_build_setup_groups(board)

        rush_session["puzzle_id"] = f"rush-{idx + 1}"
        rush_session["player_color"] = (
            "white" if board.turn == chess.WHITE else "black"
        )
        rush_session["board"] = board
        rush_session["solution_moves"] = list(puzzle["moves"])
        rush_session["solution_index"] = 0
        rush_session["pending_opponent_move"] = None
        rush_session["setup_groups"] = groups
        rush_session["setup_group_index"] = 0
        rush_session["phase"] = "loading_puzzle"

    led_safe("rush_loading")
    publish_rush("rush_puzzle_loaded")

    time.sleep(3.7)

    with lock:
        if not rush_session["active"] or rush_session["run_id"] != run_id:
            return
        if not rush_session["setup_groups"]:
            return
        first_group = rush_session["setup_groups"][0]
        rush_session["phase"] = (
            "placing_white_pieces"
            if first_group["colour"] == "white"
            else "placing_black_pieces"
        )

    rush_emit_current_piece_prompt()


def rush_advance_setup_group():
    with lock:
        if not rush_session["active"]:
            return
        if rush_session["phase"] not in {
            "placing_white_pieces",
            "placing_black_pieces",
        }:
            return

        rush_session["setup_group_index"] += 1
        if rush_session["setup_group_index"] >= len(rush_session["setup_groups"]):
            rush_session["phase"] = "waiting_for_user_move"
            finished = True
        else:
            next_group = rush_session["setup_groups"][rush_session["setup_group_index"]]
            rush_session["phase"] = (
                "placing_white_pieces"
                if next_group["colour"] == "white"
                else "placing_black_pieces"
            )
            finished = False

    if finished:
        led_safe("rush_puzzle_ready")
        publish_rush("rush_puzzle_ready")
        return

    rush_emit_current_piece_prompt()


@socketio.on("rush_start")
def handle_rush_start(data=None):
    with lock:
        if rush_session["active"]:
            publish_rush(to=request.sid)
            return

        rush_session["run_id"] += 1
        rush_session.update({
            "active": True,
            "phase": "scanning_initial_board",
            "puzzle_id": None,
            "player_color": "white",
            "board": None,
            "solution_moves": [],
            "solution_index": 0,
            "pending_opponent_move": None,
            "setup_groups": [],
            "setup_group_index": 0,
            "puzzles_solved": 0,
            "strikes": 0,
            "current_puzzle": 0,
            "results": ["unplayed"] * RUSH_TOTAL_PUZZLES,
        })

    led_safe("rush_scan_wave")
    publish_rush("rush_started")


@socketio.on("rush_end")
def handle_rush_end(data=None):
    with lock:
        rush_session["run_id"] += 1
        rush_session.update({
            "active": False,
            "phase": "idle",
            "puzzle_id": None,
            "player_color": "white",
            "board": None,
            "solution_moves": [],
            "solution_index": 0,
            "pending_opponent_move": None,
            "setup_groups": [],
            "setup_group_index": 0,
        })

    led_safe("off")
    publish_rush("rush_ended")


@socketio.on("get_rush_session")
def handle_get_rush_session(data=None):
    publish_rush(to=request.sid)


@socketio.on("rush_occupancy")
def handle_rush_occupancy(data=None):
    data = data or {}
    occupied = data.get("occupiedSquares") or []
    occupied_set = set(occupied)

    with lock:
        if not rush_session["active"]:
            return
        phase = rush_session["phase"]

        if phase == "scanning_initial_board":
            rush_session["phase"] = "waiting_for_empty_board"
            should_show_red = True
            should_advance = False
        elif phase == "waiting_for_empty_board":
            should_show_red = True
            should_advance = False
        elif phase in {"placing_white_pieces", "placing_black_pieces"}:
            should_show_red = False
            group = rush_current_setup_group()
            should_advance = bool(
                group and all(sq in occupied_set for sq in group["squares"])
            )
        else:
            return

    if should_show_red:
        # Initial empty scan always uses unflipped ("white") coordinates
        led_safe("rush_empty_required", list(occupied))
        publish_rush("rush_state")
    elif should_advance:
        rush_advance_setup_group()


@socketio.on("rush_board_cleared")
def handle_rush_board_cleared(data=None):
    with lock:
        if not rush_session["active"]:
            return
        if rush_session["phase"] not in {
            "scanning_initial_board",
            "waiting_for_empty_board",
        }:
            return
        rush_session["phase"] = "loading_puzzle"
        run_id = rush_session["run_id"]

    publish_rush("rush_loading")
    background(rush_start_puzzle, run_id)


@socketio.on("rush_confirm_piece")
def handle_rush_confirm_piece(data=None):
    rush_advance_setup_group()


@app.post("/api/rush/board")
def rush_submit_board():
    data = request.get_json(silent=True) or {}
    fen = data.get("fen")
    if not isinstance(fen, str):
        return jsonify(error="Missing FEN."), 400
    return jsonify(rush_process_board(fen))


@socketio.on("update_rush_board")
def handle_update_rush_board(data):
    data = data or {}
    fen = data.get("fen")
    if not isinstance(fen, str):
        publish_rush(
            "rush_board_rejected",
            {"reason": "Missing FEN."},
            to=request.sid,
        )
        return
    result = rush_process_board(fen)
    if result.get("error"):
        publish_rush(
            "rush_board_rejected",
            {"reason": result["error"]},
            to=request.sid,
        )


def rush_after_correct_move(run_id, puzzle_complete):
    time.sleep(1.8)

    with lock:
        if not rush_session["active"] or rush_session["run_id"] != run_id:
            return

        if not puzzle_complete:
            board = rush_session["board"]
            opp_uci = rush_session["solution_moves"][rush_session["solution_index"]]
            opp_move = chess.Move.from_uci(opp_uci)
            if opp_move not in board.legal_moves:
                return
            opp_info = move_info(board, opp_move)
            rush_session["pending_opponent_move"] = opp_info
            rush_session["phase"] = "waiting_for_opponent_move"
            led_opp_from = rush_led_square(opp_info["from"])
            led_opp_to = rush_led_square(opp_info["to"])
        else:
            opp_info = None
            led_opp_from = None
            led_opp_to = None

    if not puzzle_complete and opp_info:
        led_safe("rush_opponent_move", led_opp_from, led_opp_to)
        publish_rush("rush_opponent_move")
        publish_rush("rush_state")
        return

    rush_show_score_and_continue(run_id)


def rush_after_wrong_move(run_id):
    time.sleep(3.9)
    rush_show_score_and_continue(run_id)


def rush_show_score_and_continue(run_id):
    with lock:
        if not rush_session["active"] or rush_session["run_id"] != run_id:
            return
        rush_session["phase"] = "showing_score"
        results = list(rush_session["results"])
        strikes = rush_session["strikes"]
        current_puzzle = rush_session["current_puzzle"]

    led_safe("rush_score_strip", results)
    publish_rush("rush_puzzle_complete")

    time.sleep(3.0)

    with lock:
        if not rush_session["active"] or rush_session["run_id"] != run_id:
            return

        if strikes >= RUSH_MAX_STRIKES:
            rush_session["phase"] = "rush_complete"
            rush_session["active"] = False
            outcome = "failed"
        elif current_puzzle + 1 >= RUSH_TOTAL_PUZZLES:
            rush_session["phase"] = "rush_complete"
            rush_session["active"] = False
            outcome = "completed"
        else:
            rush_session["current_puzzle"] += 1
            rush_session["phase"] = "scanning_initial_board"
            rush_session["player_color"] = "white"
            rush_session["board"] = None
            rush_session["pending_opponent_move"] = None
            rush_session["setup_groups"] = []
            rush_session["setup_group_index"] = 0
            outcome = "next"

    if outcome == "failed":
        led_safe("rush_over", False)
        publish_rush("rush_complete")
    elif outcome == "completed":
        led_safe("rush_over", True)
        publish_rush("rush_complete")
    else:
        led_safe("rush_scan_wave")
        publish_rush("rush_next_puzzle")


def rush_process_board(fen):
    try:
        observed = chess.Board(fen)
    except Exception as exc:
        return {"error": str(exc)}

    with lock:
        if not rush_session["active"]:
            return {"error": "Puzzle Rush is not active."}

        phase = rush_session["phase"]
        board = rush_session["board"]
        run_id = rush_session["run_id"]
        pcolor = rush_session["player_color"]

        if phase == "waiting_for_opponent_move":
            pending = rush_session["pending_opponent_move"]
            if not pending:
                return {"error": "No pending opponent move."}
            opp_move = chess.Move.from_uci(pending["uci"])
            candidate = board.copy()
            candidate.push(opp_move)
            if observed.board_fen() != candidate.board_fen():
                return {
                    "error": f"Play the highlighted opponent move: {pending['san']}."
                }
            board.push(opp_move)
            rush_session["solution_index"] += 1
            rush_session["pending_opponent_move"] = None
            rush_session["phase"] = "waiting_for_user_move"
            handled_opponent = True
        else:
            handled_opponent = False

        if not handled_opponent:
            if phase != "waiting_for_user_move":
                return {"error": "Puzzle Rush is not waiting for a move."}

            expected_uci = rush_session["solution_moves"][
                rush_session["solution_index"]
            ]

            played_move = None
            for move in board.legal_moves:
                candidate = board.copy()
                candidate.push(move)
                if candidate.board_fen() == observed.board_fen():
                    played_move = move
                    break

            if played_move is None:
                return {
                    "error": (
                        "Board position is not exactly one legal "
                        "move ahead of the puzzle position."
                    )
                }

            correct = played_move.uci() == expected_uci
            played_info = move_info(board, played_move)

            if correct:
                board.push(played_move)
                rush_session["solution_index"] += 1
                puzzle_complete = (
                    rush_session["solution_index"]
                    >= len(rush_session["solution_moves"])
                )
                if puzzle_complete:
                    rush_session["puzzles_solved"] += 1
                    rush_session["results"][
                        rush_session["current_puzzle"]
                    ] = "correct"
                rush_session["phase"] = "showing_feedback"
            else:
                expected_move = chess.Move.from_uci(expected_uci)
                expected_info = move_info(board, expected_move)
                rush_session["strikes"] += 1
                rush_session["results"][
                    rush_session["current_puzzle"]
                ] = "wrong"
                rush_session["phase"] = "showing_feedback"

    if handled_opponent:
        led_safe("normal")
        publish_rush("rush_state")
        return {"status": "opponent_move_confirmed"}

    if correct:
        led_safe(
            "rush_correct_move",
            rush_led_square(played_info["from"], pcolor),
            rush_led_square(played_info["to"], pcolor),
        )
        publish_rush(
            "rush_move_result",
            {"correct": True, "playedMove": played_info},
        )
        background(rush_after_correct_move, run_id, puzzle_complete)
        return {"status": "correct"}

    led_safe(
        "rush_wrong_move",
        rush_led_square(played_info["from"], pcolor),
        rush_led_square(played_info["to"], pcolor),
        rush_led_square(expected_info["from"], pcolor),
        rush_led_square(expected_info["to"], pcolor),
    )
    publish_rush(
        "rush_move_result",
        {
            "correct": False,
            "playedMove": played_info,
            "expectedMove": expected_info,
            "strikes": rush_session["strikes"],
        },
    )
    background(rush_after_wrong_move, run_id)
    return {"status": "wrong"}











TERMINAL_EXCEPTIONS = {"created", "started"}
game_threads = set()


def lichess_finished_locked():
    return (
        S["status"] is not None
        and S["status"] not in TERMINAL_EXCEPTIONS
    )


def lichess_initial_board_locked():
    return chess.Board(S["initial_fen"])


def lichess_snapshot_locked():
    return {
        "gameId": S["game_id"],
        "phase": S["phase"],
        "myColor": S["my_color"],
        "metadata": copy.deepcopy(S["metadata"]),
        "displayFen": S["display_board"].fen(),
        "fen": S["display_board"].fen(),
        "serverFen": S["server_board"].fen(),
        "initialFen": S["initial_fen"],
        "pendingOpponentMove": (
            copy.deepcopy(S["pending_opponent"])
            if S["pending_opponent"]
            else None
        ),
        "pendingSubmission": (
            copy.deepcopy(S["pending_submission"]["info"])
            if S["pending_submission"]
            else None
        ),
        "status": S["status"],
        "winner": S["winner"],
        "clock": copy.deepcopy(S["clock"]),
        "streamConnected": S["stream_connected"],
        "error": S["error"],
    }


def publish_lichess(event="session_snapshot", extra=None, to=None):
    with lock:
        payload = lichess_snapshot_locked()

    if extra:
        payload.update(extra)

    socketio.emit(event, payload, to=to)


def publish(event="session_snapshot", extra=None, to=None):
    publish_lichess(event, extra, to)


def reject_board(reason, sid, expected=None):
    with lock:
        payload = {
            "reason": reason,
            "phase": S["phase"],
            "displayFen": S["display_board"].fen(),
        }

    if expected:
        payload["expectedFen"] = expected

    socketio.emit("board_update_rejected", payload, to=sid)


def lichess_read_clock(state, server_board):
    clock = S["clock"]

    white_ms = state.get("wtime")
    black_ms = state.get("btime")

    if white_ms is None and state.get("wc") is not None:
        white_ms = state["wc"] * 1000

    if black_ms is None and state.get("bc") is not None:
        black_ms = state["bc"] * 1000

    if white_ms is not None:
        clock["whiteMs"] = white_ms

    if black_ms is not None:
        clock["blackMs"] = black_ms

    if "winc" in state:
        clock["whiteIncrementMs"] = state["winc"]

    if "binc" in state:
        clock["blackIncrementMs"] = state["binc"]

    clock["receivedAtMs"] = int(time.time() * 1000)

    if S["status"] == "started":
        clock["runningColor"] = (
            "white" if server_board.turn else "black"
        )
    else:
        clock["runningColor"] = None

    clock["status"] = S["status"]



def lichess_led_square(square):
    if not square:
        return None
    return rush_led_square(square, S.get("my_color") or "white")



def lichess_process_game_state(game_id, state):
    if not isinstance(state, dict):
        return

    local_confirmation = None
    opponent_move = None

    with lock:
        if S["game_id"] != game_id:
            return

        status = state.get("status")

        if isinstance(status, dict):
            status = status.get("name")

        if status:
            S["status"] = status

        if "winner" in state:
            S["winner"] = state.get("winner")

        moves_field = state.get("moves")

        if isinstance(moves_field, str) and moves_field.strip():
            moves = moves_field.split()

            if (
                len(S["server_moves"]) > len(moves)
                or moves[: len(S["server_moves"])] != S["server_moves"]
            ):
                S["phase"] = "resync_required"
                S["error"] = (
                    "Lichess move history changed. "
                    "Takebacks require restarting the game."
                )

            S["server_moves"] = moves
        else:
            last_move = state.get("lm")

            if last_move and (
                not S["server_moves"]
                or S["server_moves"][-1] != last_move
            ):
                S["server_moves"].append(last_move)

        server_board = lichess_initial_board_locked()

        for uci in S["server_moves"]:
            move = chess.Move.from_uci(uci)

            if move not in server_board.legal_moves:
                S["phase"] = "resync_required"
                S["error"] = (
                    f"Invalid move in Lichess stream: {uci}"
                )
                break

            server_board.push(move)

        S["server_board"] = server_board

        lichess_read_clock(state, server_board)

        last_uci = (
            S["server_moves"][-1]
            if S["server_moves"]
            else None
        )

        if last_uci:
            last_move = chess.Move.from_uci(last_uci)
            moving_color = (
                "white" if server_board.turn == chess.BLACK else "black"
            )

            if (
                moving_color != S["my_color"]
                and S["display_board"].board_fen()
                != server_board.board_fen()
            ):
                if S["pending_opponent"] is None or (
                    S["pending_opponent"]["uci"] != last_uci
                ):
                    if last_move:
                        pre_move_board = chess.Board(S["initial_fen"])

                        for past_move in S["server_moves"][:-1]:
                            pre_move_board.push_uci(past_move)

                        S["pending_opponent"] = move_info(
                            pre_move_board,
                            last_move,
                        )
                    else:
                        S["pending_opponent"] = None

                S["phase"] = "opponent_move_pending"
                opponent_move = S["pending_opponent"]

            elif (
                S["pending_submission"]
                and S["pending_submission"]["uci"] == last_uci
            ):
                S["display_board"] = (
                    S["pending_submission"]["expected_board"]
                )
                local_confirmation = (
                    S["pending_submission"]["info"]
                )
                S["pending_submission"] = None

        if S["phase"] != "resync_required":
            if S["pending_submission"]:
                S["phase"] = "validating_move"
            elif S["pending_opponent"]:
                S["phase"] = "opponent_move_pending"
            elif lichess_finished_locked():
                S["phase"] = "game_over"
            else:
                turn = (
                    "white"
                    if S["server_board"].turn
                    else "black"
                )

                S["phase"] = (
                    "your_turn"
                    if turn == S["my_color"]
                    else "waiting_for_opponent"
                )

        terminal = lichess_finished_locked()
        clock_payload = copy.deepcopy(S["clock"])

    socketio.emit(
        "clock_update",
        {
            "gameId": game_id,
            **clock_payload,
        },
    )

    if local_confirmation:
        publish_lichess(
            "game_state_update",
            {
                "turn": (
                    "white"
                    if S["display_board"].turn
                    else "black"
                ),
                "sanMove": local_confirmation["san"],
                "lastMove": {
                    "from": local_confirmation["from"],
                    "to": local_confirmation["to"],
                },
            },
        )

        led_safe(
            "last",
            lichess_led_square(local_confirmation["from"]),
            lichess_led_square(local_confirmation["to"]),
        )

        if S["display_board"].is_check():
            checked_square = chess.square_name(
                S["display_board"].king(
                    S["display_board"].turn
                )
            )

            led_safe(
                "check",
                lichess_led_square(checked_square),
            )

    if opponent_move:
        publish_lichess(
            "opponent_move_pending",
            {
                "pendingOpponentMove": opponent_move,
            },
        )
        led_safe(
            "pending",
            lichess_led_square(opponent_move["from"]),
            lichess_led_square(opponent_move["to"]),
        )

    publish_lichess()

    if terminal:
        background(
            save_finished_lichess_game,
            game_id,
        )
        publish_lichess("game_over")
        if S["winner"] == S["my_color"]:
            led_game_over("white_win")
        elif S["winner"] and S["winner"] != S["my_color"]:
            led_game_over("black_win")
        else:
            led_game_over("draw")

def lichess_setup_after_match():
    time.sleep(0.6)
    led_safe("setup")


def lichess_load_game_full(game_id, full):
    variant = (full.get("variant") or {}).get("key", "standard")

    if variant != "standard":
        raise ValueError(
            "This prototype supports standard chess only."
        )

    players = full.get("players") or {}
    white = players.get("white") or {}
    black = players.get("black") or {}

    white_user = white
    black_user = black

    initial = full.get("initialFen") or chess.STARTING_FEN

    if initial == "startpos":
        initial = chess.STARTING_FEN

    with lock:
        if S["game_id"] != game_id:
            return

        white_id = str(white_user.get("id", "")).lower()
        black_id = str(black_user.get("id", "")).lower()

        if white_id == MY_ACCOUNT_ID:
            S["my_color"] = "white"
        elif black_id == MY_ACCOUNT_ID:
            S["my_color"] = "black"

        if S["my_color"] not in {"white", "black"}:
            raise ValueError("Could not identify your colour.")

        if S["my_color"] == "white":
            me = white_user
            opponent = black_user
        else:
            me = black_user
            opponent = white_user

        S["initial_fen"] = initial
        S["display_board"] = chess.Board(initial)
        S["server_board"] = chess.Board(initial)
        S["server_moves"] = []
        S["pending_opponent"] = None
        S["pending_submission"] = None
        S["stream_connected"] = True
        S["error"] = None

        initial_board = chess.Board(initial)

        if not S["server_moves"]:
            S["phase"] = "waiting_for_pieces"
        elif initial_board.turn == chess.WHITE:
            S["phase"] = (
                "your_turn"
                if S["my_color"] == "white"
                else "waiting_for_opponent"
            )
        else:
            S["phase"] = (
                "your_turn"
                if S["my_color"] == "black"
                else "waiting_for_opponent"
            )

        S["metadata"] = {
            "playerUsername": me.get("name") or me.get("id"),
            "playerRating": me.get("rating"),
            "opponentUsername": opponent.get("name") or opponent.get("id"),
            "opponentRating": opponent.get("rating"),
            "rated": full.get("rated"),
            "speed": full.get("speed"),
            "variant": variant,
            "createdAt": full.get("createdAt"),
            "clockConfig": full.get("clock"),
            "lichessUrl": f"{BASE}/{game_id}",
        }

        metadata = copy.deepcopy(S["metadata"])

    socketio.emit("match_found", {
        "gameId": game_id,
        "phase": S["phase"],
        "myColor": S["my_color"],
        "rated": full.get("rated"),
        "metadata": metadata,
        "playerUsername": metadata.get("playerUsername"),
        "playerRating": metadata.get("playerRating"),
        "opponentUsername": metadata.get("opponentUsername"),
        "opponentRating": metadata.get("opponentRating"),
    })
    if S["phase"] == "waiting_for_pieces":
        led_safe("match_found")
        background(lichess_setup_after_match)
    else:
        led_safe("normal")

    print("GAME LOADED AND MATCH FOUND EMITTED:", game_id)


def lichess_run_game_stream(game_id):
    delay = 2

    try:
        while True:
            with lock:
                if S["game_id"] != game_id:
                    return

            wait = delay

            try:
                print("OPENING GAME STREAM:", game_id)

                with requests.get(
                    f"{BASE}/api/board/game/stream/{game_id}",
                    headers={
                        "Authorization": f"Bearer {LICHESS_TOKEN}",
                        "Accept": "application/x-ndjson",
                    },
                    timeout=(10, None),
                    stream=True,
                ) as response:
                    print(
                        "GAME STREAM STATUS:",
                        response.status_code,
                        response.headers.get("Content-Type"),
                    )

                    if response.status_code != 200:
                        raise ValueError(
                            f"Cannot open game stream "
                            f"({response.status_code}): "
                            f"{api_error(response)}"
                        )

                    for line in response.iter_lines(chunk_size=1):
                        if not line:
                            continue

                        print("GAME STREAM RAW LINE:", line)

                        try:
                            event = json.loads(line)
                            print(
                                "PARSED EVENT KEYS:",
                                list(event.keys()),
                            )
                        except (
                            json.JSONDecodeError,
                            UnicodeDecodeError,
                        ) as exc:
                            print(
                                "GAME STREAM JSON ERROR:",
                                exc,
                            )
                            continue

                        event_type = event.get("type")

                        if event_type == "gameFull":
                            print("GAME FULL RECEIVED:", game_id)
                            lichess_load_game_full(game_id, event)

                        elif event_type == "gameState":
                            with lock:
                                S["stream_connected"] = True

                            lichess_process_game_state(
                                game_id,
                                event,
                            )

                    with lock:
                        if lichess_finished_locked():
                            return

            except ValueError as exc:
                with lock:
                    if S["game_id"] == game_id:
                        S["phase"] = "resync_required"
                        S["error"] = str(exc)

                publish_lichess("game_error")
                return

            except requests.RequestException as exc:
                print("Game stream connection error:", exc)

            finally:
                with lock:
                    if S["game_id"] == game_id:
                        S["stream_connected"] = False

            publish_lichess()
            time.sleep(wait)
            delay = min(delay * 2, 30)

    finally:
        with lock:
            game_threads.discard(game_id)


@socketio.on("update_board")
def handle_lichess_board_update(data):
    sid = request.sid

    try:
        if not isinstance(data, dict):
            raise ValueError("Expected an object containing 'fen'.")

        fen = data.get("fen")

        if not isinstance(fen, str):
            raise ValueError("Missing FEN string.")

        observed = chess.Board(fen)
        placement = observed.board_fen()

    except (ValueError, TypeError) as exc:
        reject_board(str(exc), sid)
        led_safe("illegal")
        return

    submission_job = None
    initial_ready = False
    unchanged = False
    confirmed = None
    checked_king_square = None
    error = None
    expected = None

    with lock:
        if not S["game_id"]:
            error = "No Lichess game loaded."

        elif S["phase"] == "resync_required":
            error = S["error"] or "Lichess session requires resync."

        elif S["phase"] == "waiting_for_pieces":
            initial_board = lichess_initial_board_locked()

            if placement == initial_board.board_fen():
                S["display_board"] = initial_board.copy()
                S["error"] = None

                turn = (
                    "white"
                    if initial_board.turn
                    else "black"
                )

                S["phase"] = (
                    "your_turn"
                    if turn == S["my_color"]
                    else "waiting_for_opponent"
                )

                initial_ready = True
            else:
                error = (
                    "Place all pieces in the required "
                    "starting position."
                )

        elif S["pending_submission"]:
            error = (
                "Waiting for Lichess to confirm the submitted move."
            )

        elif placement == S["display_board"].board_fen():
            unchanged = True
            S["error"] = None

        elif S["pending_opponent"]:
            pending = S["pending_opponent"]
            expected_board = S["display_board"].copy()

            move = chess.Move.from_uci(pending["uci"])

            if move not in expected_board.legal_moves:
                error = "Pending opponent move is no longer legal."
            else:
                expected_board.push(move)

                if placement != expected_board.board_fen():
                    error = (
                        "Play the highlighted opponent move: "
                        f"{pending['san']}."
                    )
                    expected = expected_board.fen()
                else:
                    S["display_board"] = expected_board
                    confirmed = pending
                    S["pending_opponent"] = None
                    S["error"] = None

                    if expected_board.is_check():
                        checked_king_square = chess.square_name(
                            expected_board.king(
                                expected_board.turn
                            )
                        )

                    if lichess_finished_locked():
                        S["phase"] = "game_over"
                    else:
                        S["phase"] = (
                            "your_turn"
                            if (
                                "white"
                                if expected_board.turn
                                else "black"
                            ) == S["my_color"]
                            else "waiting_for_opponent"
                        )

        elif S["phase"] != "your_turn":
            error = (
                "It is not your turn. "
                "Wait for your opponent to move on Lichess."
            )

        elif not S["stream_connected"]:
            error = "Lichess game stream is reconnecting."

        else:
            matches = []

            for move in S["display_board"].legal_moves:
                candidate = S["display_board"].copy()
                candidate.push(move)

                if candidate.board_fen() == placement:
                    matches.append((move, candidate))

            if len(matches) != 1:
                error = (
                    "Board position is not exactly one legal move "
                    "ahead of the current app position."
                )
            else:
                move, candidate = matches[0]
                info = move_info(S["display_board"], move)

                S["pending_submission"] = {
                    "uci": move.uci(),
                    "expected_board": candidate,
                    "info": info,
                }
                S["error"] = None
                S["phase"] = "validating_move"
                submission_job = (
                    S["game_id"],
                    move.uci(),
                )

    if error:
        reject_board(error, sid, expected)
        led_safe("illegal")
        return

    if initial_ready:
        led_safe("ready")
        publish_lichess()
        return

    if unchanged:
        with lock:
            last_from = None
            last_to = None
            if S["display_board"].move_stack:
                last_move = S["display_board"].peek()
                last_from = chess.square_name(last_move.from_square)
                last_to = chess.square_name(last_move.to_square)

            pending = S["pending_opponent"]
            pending_from = pending["from"] if pending else None
            pending_to = pending["to"] if pending else None

        if pending_from and pending_to:
            led_safe(
                "game_highlight",
                lichess_led_square(last_from),
                lichess_led_square(last_to),
                lichess_led_square(pending_from),
                lichess_led_square(pending_to),
            )
        elif last_from and last_to:
            led_safe(
                "last",
                lichess_led_square(last_from),
                lichess_led_square(last_to),
            )
        else:
            led_safe("normal")

        publish_lichess()
        return

    if confirmed:
        publish_lichess(
            "game_state_update",
            {
                "turn": (
                    "white"
                    if S["display_board"].turn
                    else "black"
                ),
                "sanMove": confirmed["san"],
                "lastMove": {
                    "from": confirmed["from"],
                    "to": confirmed["to"],
                },
            },
        )
        led_safe(
            "last",
            lichess_led_square(confirmed["from"]),
            lichess_led_square(confirmed["to"]),
        )

        if checked_king_square:
            led_safe(
                "check",
                lichess_led_square(checked_king_square),
            )

    publish_lichess()

    if submission_job:
        background(submit_lichess_move, *submission_job)

def submit_lichess_move(game_id, uci):
    try:
        with requests.post(
            f"{BASE}/api/board/game/{game_id}/move/{uci}",
            headers=headers(),
            timeout=(10, 15),
        ) as response:
            if response.status_code == 200:
                return

            detail = api_error(response)

            with lock:
                if S["game_id"] == game_id:
                    S["pending_submission"] = None
                    S["phase"] = "your_turn"
                    S["error"] = (
                        f"Lichess rejected move {uci}: {detail}"
                    )

            socketio.emit(
                "move_submission_error",
                {
                    "gameId": game_id,
                    "move": uci,
                    "reason": detail,
                },
            )

            publish_lichess()

    except requests.RequestException as exc:
        with lock:
            if S["game_id"] == game_id:
                S["pending_submission"] = None
                S["phase"] = "your_turn"
                S["error"] = f"Network error: {exc}"

        socketio.emit(
            "move_submission_error",
            {
                "gameId": game_id,
                "move": uci,
                "reason": str(exc),
            },
        )

        publish_lichess()


def seek_payload(config):
    value = float(config.get("timeLimit", 10))
    unit = config.get("timeUnit", DEFAULT_TIME_UNIT)

    if unit == "seconds":
        value /= 60
    elif unit != "minutes":
        raise ValueError("timeUnit must be minutes or seconds.")

    if not math.isfinite(value) or value <= 0:
        raise ValueError("Invalid timeLimit.")

    increment = float(config.get("increment", 0))

    if (
        not math.isfinite(increment)
        or increment < 0
        or not increment.is_integer()
    ):
        raise ValueError("increment must be a non-negative integer.")

    color = config.get("color", "random")

    if color not in {"random", "white", "black"}:
        raise ValueError("Invalid color.")

    rated = config.get("rated", False)

    if not isinstance(rated, bool):
        raise ValueError("rated must be a JSON boolean.")

    return {
        "rated": "true" if rated else "false",
        "variant": "standard",
        "ratingRange": "",
        "time": int(value) if value.is_integer() else value,
        "increment": int(increment),
        "color": color,
    }


def run_seek(payload, request_id):
    failure_reason = None
    should_emit_failure = False

    try:
        with requests.post(
            f"{BASE}/api/board/seek",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": f"Bearer {LICHESS_TOKEN}"
            },
            data=payload,
            stream=True,
            timeout=(10, None),
        ) as response:
            if response.status_code != 200:
                failure_reason = (
                    f"Lichess rejected seek "
                    f"({response.status_code}): "
                    f"{api_error(response)}"
                )

                with lock:
                    if (
                        S["request_id"] == request_id
                        and S["phase"] == "searching"
                    ):
                        S["phase"] = "seek_failed"
                        S["error"] = failure_reason
                        should_emit_failure = True

                if should_emit_failure:
                    socketio.emit(
                        "match_failed",
                        {"reason": failure_reason},
                    )

                    led_safe("match_failed")

                return

            with lock:
                if S["request_id"] == request_id:
                    S["phase"] = "searching"
                    S["error"] = None

            publish_lichess("match_status")

            for _ in response.iter_lines(chunk_size=1):
                pass

            # Seek stream ended without a game starting.
            with lock:
                if (
                    S["request_id"] == request_id
                    and S["phase"] == "searching"
                    and not S["game_id"]
                ):
                    failure_reason = (
                        "Matchmaking ended without finding an opponent."
                    )

                    S["phase"] = "seek_failed"
                    S["error"] = failure_reason
                    should_emit_failure = True

            if should_emit_failure:
                socketio.emit(
                    "match_failed",
                    {"reason": failure_reason},
                )

                led_safe("match_failed")

    except requests.RequestException as exc:
        failure_reason = f"Network error while matchmaking: {exc}"

        with lock:
            if S["request_id"] == request_id:
                S["phase"] = "seek_failed"
                S["error"] = failure_reason
                should_emit_failure = True

        publish_lichess("match_status")

        if should_emit_failure:
            socketio.emit(
                "match_failed",
                {"reason": failure_reason},
            )

            led_safe("match_failed")

    finally:
        with lock:
            if S["request_id"] == request_id:
                S["seek_running"] = False

# eval_related


@socketio.on("eval_start")
def handle_eval_start(data):
    with eval_session["lock"]:
        if eval_session["active"]:
            return

        eval_session["active"] = True
        eval_session["phase"] = "waiting_for_kings"
        eval_session["side_to_move"] = data.get(
            "side_to_move",
            "white",
        )
        eval_session["last_position"] = None
        eval_session["position_version"] += 1
        eval_session["cancel_requested"] = False

    eval_emit_state(
        "Place both kings on the board.",
        "waiting_for_kings",
    )

    led_sweep_perimeter()

    threading.Thread(
        target=eval_monitor_loop,
        daemon=True,
    ).start()


@socketio.on("eval_end")
def handle_eval_end():
    with eval_session["lock"]:
        eval_session["active"] = False
        eval_session["cancel_requested"] = True
        eval_session["phase"] = "idle"
        eval_session["last_position"] = None

    led_clear_eval()

    eval_emit_state(
        "Evaluation ended.",
        "idle",
    )


def eval_monitor_loop():
    while True:
        with eval_session["lock"]:
            if not eval_session["active"]:
                return

            phase = eval_session["phase"]

        if phase == "waiting_for_kings":
            board_image = capture_board_image()

            kings_present = detect_both_kings(board_image)

            if kings_present:
                with eval_session["lock"]:
                    eval_session["phase"] = (
                        "waiting_for_hand_removal"
                    )

                eval_emit_state(
                    "Both kings detected. Remove your hand to begin.",
                    "waiting_for_hand_removal",
                )

                led_breathing_perimeter()

        elif phase == "waiting_for_hand_removal":
            board_image = capture_board_image()

            kings_present = detect_both_kings(board_image)
            hand_present = detect_hand(board_image)

            if not kings_present:
                with eval_session["lock"]:
                    eval_session["phase"] = "waiting_for_kings"

                eval_emit_state(
                    "Waiting for both kings.",
                    "waiting_for_kings",
                )

                led_dim_board()

            elif not hand_present:
                with eval_session["lock"]:
                    eval_session["phase"] = "settling"

                eval_emit_state(
                    "Checking position…",
                    "settling",
                )

                led_inward_fade()

                time.sleep(1.0)

                with eval_session["lock"]:
                    eval_session["phase"] = "recognising"

                eval_emit_state(
                    "Reading board…",
                    "recognising",
                )

                led_vibgyor_ripple()

        elif phase == "settling":
            time.sleep(0.1)

        elif phase == "recognising":
            board_image = capture_board_image()

            hand_present = detect_hand(board_image)

            if hand_present:
                with eval_session["lock"]:
                    eval_session["phase"] = (
                        "waiting_for_hand_removal"
                    )

                eval_emit_state(
                    "Remove your hand to begin.",
                    "waiting_for_hand_removal",
                )

                led_breathing_perimeter()

                continue

            position = detect_pieces(board_image)

            if position is None:
                with eval_session["lock"]:
                    eval_session["phase"] = (
                        "waiting_for_hand_removal"
                    )

                eval_emit_state(
                    "Could not read the position clearly. Try again.",
                    "waiting_for_hand_removal",
                )

                led_error_flash()

                continue

            with eval_session["lock"]:
                eval_session["last_position"] = position
                eval_session["phase"] = "evaluating"
                eval_session["position_version"] += 1
                current_version = eval_session["position_version"]

            eval_emit_state(
                "Evaluating…",
                "evaluating",
            )

            led_eval_wave()

            fen = position_to_fen(
                position,
                eval_session["side_to_move"],
            )

            result = run_stockfish(
                fen,
                eval_session["side_to_move"],
            )

            with eval_session["lock"]:
                still_current = (
                    eval_session["active"]
                    and eval_session["position_version"] == current_version
                )

            if still_current:
                evaluation = result.get("evaluation", 0)

                with eval_session["lock"]:
                    eval_session["phase"] = "eval_ready"

                led_show_eval(evaluation)

                socketio.emit(
                    "eval_ready",
                    {
                        "evaluation": evaluation,
                        "fen": fen,
                    },
                )

                eval_emit_state(
                    "Evaluation ready.",
                    "eval_ready",
                )

        elif phase == "eval_ready":
            board_image = capture_board_image()

            hand_present = detect_hand(board_image)

            if hand_present:
                with eval_session["lock"]:
                    eval_session["phase"] = "editing"

                eval_emit_state(
                    "Position being edited.",
                    "editing",
                )

                led_dim_board()

        elif phase == "editing":
            board_image = capture_board_image()

            hand_present = detect_hand(board_image)

            if not hand_present:
                with eval_session["lock"]:
                    eval_session["phase"] = "settling"

                eval_emit_state(
                    "Checking position…",
                    "settling",
                )

                led_inward_fade()

                time.sleep(1.0)

                with eval_session["lock"]:
                    eval_session["phase"] = "recognising"

                eval_emit_state(
                    "Reading board…",
                    "recognising",
                )

                led_vibgyor_ripple()

        time.sleep(0.15)


def capture_board_image():
    return None


def detect_both_kings(image):
    return False


def detect_hand(image):
    return False


def detect_pieces(image):
    return None


def position_to_fen(position, side_to_move):
    return (
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/"
        "RNBQKBNR w KQkq - 0 1"
    )


def run_stockfish(fen, side_to_move):
    return {
        "evaluation": 0,
    }


def led_sweep_perimeter():
    pass


def led_breathing_perimeter():
    pass


def led_inward_fade():
    pass


def led_vibgyor_ripple():
    pass


def led_eval_wave():
    pass


def led_show_eval(evaluation):
    pass


def led_clear_eval():
    pass


def led_dim_board():
    pass


def led_error_flash():
    pass


# eval_related





@app.route("/api/lichess/seek", methods=["POST", "OPTIONS"])
def create_seek():
    if request.method == "OPTIONS":
        return "", 200

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify(error="Expected JSON object."), 400

    sid = data.get("socketId")

    with lock:
        if sid not in clients:
            return jsonify(
                error=(
                    "Use the currently connected Socket.IO socket.id."
                )
            ), 400

    try:
        config = data.get("config") or {}

        if not isinstance(config, dict):
            raise ValueError("config must be an object.")

        payload = seek_payload(config)

    except (ValueError, TypeError, OverflowError) as exc:
        return jsonify(error=str(exc)), 400

    ensure_account_listener()

    if not events_ready.wait(12):
        return jsonify(
            error="Lichess event stream unavailable."
        ), 503

    with lock:
    # Recover from a failed or uncertain previous seek.
        if S["phase"] in {"seek_failed", "seek_uncertain"}:
            S["request_id"] = None
            S["seek_running"] = False
            S["phase"] = "idle"
            S["error"] = None

        # Recover from a stale searching state with no active seek thread.
        if (
            S["phase"] == "searching"
            and not S["seek_running"]
            and not S["game_id"]
        ):
            S["request_id"] = None
            S["phase"] = "idle"
            S["error"] = None

        if S["seek_running"]:
            return jsonify(error="A seek is already running."), 409

        if S["game_id"] and not lichess_finished_locked():
            return jsonify(
                error="A game is already active.",
                gameId=S["game_id"],
            ), 409

        request_id = uuid.uuid4().hex
        S["request_id"] = request_id
        S["seek_running"] = True
        S["phase"] = "searching"
        S["error"] = None

        led_safe("loading", "vibgyor_loop", True)

    background(run_seek, payload, request_id)

    return jsonify(
        status="searching",
        requestId=request_id,
    )


def start_game(game):
    print("START_GAME CALLED:", game)
    game_id = game.get("gameId") or game.get("fullId")

    if not game_id:
        return

    with lock:
        if S["game_id"] == game_id:
            return

        if S["game_id"] and not lichess_finished_locked():
            print("Ignoring second simultaneous game:", game_id)
            return

        S.update({
            "request_id": None,
            "seek_running": False,
            "game_id": game_id,
            "phase": "loading_game",
            "my_color": game.get("color"),
            "metadata": {},
            "initial_fen": chess.STARTING_FEN,
            "display_board": chess.Board(),
            "server_board": chess.Board(),
            "server_moves": [],
            "pending_opponent": None,
            "pending_submission": None,
            "stream_connected": False,
            "status": None,
            "winner": None,
            "clock": {},
            "error": None,
        })

        if game_id in game_threads:
            return

        game_threads.add(game_id)

        upsert_game(
            game_id=game_id,
            mode="lichess",
            player_color=game.get("color"),
            bot_elo=None,
            initial_fen=chess.STARTING_FEN,
            moves=[],
            sans=[],
            status=None,
            winner=None
        )

    publish_lichess("match_status")
    background(lichess_run_game_stream, game_id)


def save_finished_lichess_game(game_id):
    with lock:
        if S["game_id"] != game_id:
            return

        upsert_game(
            game_id=game_id,
            mode="lichess",
            player_color=S["my_color"],
            bot_elo=None,
            initial_fen=S["initial_fen"],
            moves=S["server_moves"],
            sans=[],
            status=S["status"],
            winner=S["winner"],
            opponent_username=S["metadata"].get("opponentUsername"),
        )


def run_account_events():
    delay = 2

    while True:
        wait = delay

        try:
            events_ready.clear()

            with requests.get(
                f"{BASE}/api/stream/event",
                headers=headers(),
                stream=True,
                timeout=(10, 90),
            ) as response:
                if response.status_code in {401, 403}:
                    print(
                        "Account event authentication error:",
                        api_error(response),
                    )
                    return

                if response.status_code == 429:
                    wait = 60
                else:
                    response.raise_for_status()
                    events_ready.set()
                    delay = 2
                    print(
                        "Lichess account event stream connected."
                    )

                    for line in response.iter_lines(chunk_size=1):
                        if not line:
                            continue

                        try:
                            event = json.loads(line)
                        except (
                            json.JSONDecodeError,
                            UnicodeDecodeError,
                        ):
                            continue

                        if event.get("type") == "gameStart":
                            print(
                                "LICHESS GAME START:",
                                event.get("game", {}).get("id"),
                            )
                            start_game(event.get("game") or {})

        except (requests.RequestException, ValueError) as exc:
            print("Account stream error:", exc)

        finally:
            events_ready.clear()

        time.sleep(wait)
        delay = min(delay * 2, 30)


def ensure_account_listener():
    global event_thread

    with startup_lock:
        if event_thread and event_thread.is_alive():
            return

        event_thread = threading.Thread(
            target=run_account_events,
            daemon=True,
        )
        event_thread.start()


def initialise_account():
    global MY_ACCOUNT_ID

    with requests.get(
        f"{BASE}/api/account",
        headers=headers(),
        timeout=(10, 15),
    ) as response:
        response.raise_for_status()
        account = response.json()

    MY_ACCOUNT_ID = str(account["id"]).lower()
    print("Authenticated Lichess account:", account.get("username"))


@app.get("/api/lichess/status")
def get_status():
    with lock:
        result = lichess_snapshot_locked()
        result["eventStreamConnected"] = events_ready.is_set()
        result["seekRunning"] = S["seek_running"]

    return jsonify(result)


@app.post("/api/lichess/clear-error")
def clear_error():
    with lock:
        if S["phase"] == "seek_failed":
            S["request_id"] = None
            S["seek_running"] = False
            S["phase"] = "idle"
            S["error"] = None

    return jsonify(lichess_snapshot_locked())


@app.post("/api/lichess/reset")
def reset_lichess_state():
    with lock:
        S.update({
            "request_id": None,
            "seek_running": False,
            "game_id": None,
            "phase": "idle",
            "my_color": None,
            "metadata": {},
            "initial_fen": chess.STARTING_FEN,
            "display_board": chess.Board(),
            "server_board": chess.Board(),
            "server_moves": [],
            "pending_opponent": None,
            "pending_submission": None,
            "stream_connected": False,
            "status": None,
            "winner": None,
            "clock": {},
            "error": None,
        })

    publish_lichess("match_status")

    return jsonify(lichess_snapshot_locked())


@app.post("/api/lichess/game/<game_id>/resign")
def resign_lichess_game(game_id):
    with lock:
        if S["game_id"] != game_id:
            return jsonify(
                error="No matching active Lichess game."
            ), 404

        if lichess_finished_locked():
            return jsonify(
                error="This game has already ended."
            ), 409

    try:
        response = requests.post(
            f"{BASE}/api/board/game/{game_id}/resign",
            headers=headers(),
            timeout=(10, 15),
        )

        if response.status_code != 200:
            return jsonify(
                error=(
                    f"Lichess rejected resignation "
                    f"({response.status_code}): "
                    f"{api_error(response)}"
                )
            ), response.status_code

        return jsonify(
            status="ok",
            message=(
                "Resignation submitted. Waiting for Lichess "
                "confirmation."
            ),
        )

    except requests.RequestException as exc:
        return jsonify(
            error=f"Could not resign: {exc}"
        ), 502


@app.get("/api/lichess/game/<game_id>/pgn")
def get_game_pgn(game_id):
    try:
        with requests.get(
            f"{BASE}/game/export/{game_id}",
            headers={
                "Authorization": f"Bearer {LICHESS_TOKEN}",
                "Accept": "application/x-chess-pgn",
            },
            timeout=(10, 15),
        ) as response:
            if response.status_code != 200:
                return jsonify(
                    error=(
                        f"Lichess could not export PGN "
                        f"(HTTP {response.status_code})."
                    )
                ), response.status_code

            return Response(
                response.text,
                mimetype="application/x-chess-pgn",
            )

    except requests.RequestException as exc:
        return jsonify(error=f"Network error: {exc}"), 502


# =========================================================
# Socket.IO: frontend and interactive_sender.py
# =========================================================


@socketio.on("connect")
def handle_connect(auth=None):
    with lock:
        clients.add(request.sid)

    print("Socket connected:", request.sid)
    publish(to=request.sid)


@socketio.on("disconnect")
def handle_disconnect(reason=None):
    with lock:
        clients.discard(request.sid)


@socketio.on("get_session")
def handle_get_session(data=None):
    publish_lichess(to=request.sid)


@socketio.on("clear_seek_error")
def handle_clear_seek_error(data=None):
    with lock:
        if S["phase"] in {"seek_failed", "seek_uncertain"}:
            S["request_id"] = None
            S["seek_running"] = False
            S["phase"] = "idle"
            S["error"] = None

    publish_lichess(to=request.sid)

def casual_intro_sequence():
    """
    Blank briefly, play the centre-out curtain reveal,
    then show the dim setup board while waiting for pieces.
    """
    led_safe("blank")
    time.sleep(0.15)

    led_safe("loading", "curtain")
    time.sleep(2.3)

    led_safe("setup")



def bot_intro_sequence():
    """
    Blank briefly, play the curtain reveal, then show the dim setup board.
    """
    led_safe("blank")
    time.sleep(0.15)

    led_safe("loading", "curtain")
    time.sleep(2.3)

    led_safe("setup")




@socketio.on("cancel_matchmaking")
def handle_cancel_matchmaking(data=None):
    with lock:
        if S["phase"] in {
            "searching",
            "seek_failed",
            "seek_uncertain",
        }:
            S["request_id"] = None
            S["seek_running"] = False
            S["phase"] = "idle"
            S["error"] = None

    led_safe("off")

    publish_lichess("match_status")



@socketio.on("matchmaking_failed")
def handle_matchmaking_failed(data=None):
    with lock:
        if S["phase"] in {
            "searching",
            "seek_failed",
            "seek_uncertain",
        }:
            S["request_id"] = None
            S["seek_running"] = False
            S["phase"] = "seek_failed"
            S["error"] = (
                S["error"]
                or "Matchmaking failed."
            )

    led_safe("match_failed")

    publish_lichess("match_status")


@socketio.on("start_bot_game")
def handle_start_bot_game(data=None):
    print("BOT START REQUEST RECEIVED:", data)
    data = data or {}

    try:
        bot_elo = int(data.get("botElo", 1500))
        color = data.get("color", "white")
    except (TypeError, ValueError):
        publish_bot(
            "bot_error",
            {"error": "Invalid bot configuration."},
            to=request.sid,
        )
        return

    if color not in {"white", "black", "random"}:
        color = "white"

    if color == "random":
        color = "white" if random.random() < 0.5 else "black"

    with lock:
        BOT.update({
            "game_id": f"bot-{uuid.uuid4().hex[:10]}",
            "phase": "waiting_for_pieces",
            "player_color": color,
            "bot_color": "black" if color == "white" else "white",
            "bot_elo": bot_elo,
            "board": chess.Board(),
            "moves": [],
            "sans": [],
            "initial_fen": chess.STARTING_FEN,
            "pending_bot_move": None,
            "last_confirmed_placement": None,
            "status": None,
            "winner": None,
            "error": None,
        })

        snapshot = bot_snapshot()

    publish_bot(
        "bot_game_started",
        snapshot,
    )

    background(bot_intro_sequence)

    print("BOT GAME STARTED: WAITING FOR PHYSICAL PIECES")

def bot_led_square(square):
    if not square:
        return None
    return rush_led_square(square, BOT["player_color"])
def run_bot_turn():
    with lock:
        if BOT["phase"] != "bot_thinking":
            return

        fen = BOT["board"].fen()
        game_id = BOT["game_id"]
        elo = BOT["bot_elo"]

    print("BOT TURN: thinking for", game_id, "elo", elo)

    try:
        analysis = get_bot_move(fen, elo)

    except Exception as exc:
        print("BOT TURN ERROR:", exc)

        with lock:
            if (
                BOT["game_id"] != game_id
                or BOT["phase"] != "bot_thinking"
            ):
                return

            BOT["phase"] = "your_turn"
            BOT["error"] = f"Bot engine error: {exc}"

        publish_bot(
            "bot_error",
            {"error": BOT["error"]},
        )
        return

    pv = analysis.get("pv")

    if not pv:
        with lock:
            if (
                BOT["game_id"] != game_id
                or BOT["phase"] != "bot_thinking"
            ):
                return

            BOT["phase"] = "your_turn"
            BOT["error"] = "Bot engine did not return a move."

        publish_bot(
            "bot_error",
            {"error": BOT["error"]},
        )
        return

    move = pv[0]
    score = analysis["score"].relative

    eval_payload = {
        "gameId": game_id,
        "mode": "bot",
        "fen": fen,
        "depth": EVAL_DEPTH,
        "bestMove": move.uci(),
    }

    if score.is_mate():
        eval_payload["mate"] = score.mate()
        eval_payload["evalCp"] = None
    else:
        eval_payload["mate"] = None
        eval_payload["evalCp"] = score.score()

    socketio.emit("eval_update", eval_payload)

    with lock:
        if (
            BOT["game_id"] != game_id
            or BOT["phase"] != "bot_thinking"
            or BOT["board"].fen() != fen
        ):
            return

        board = BOT["board"]

        if move not in board.legal_moves:
            BOT["phase"] = "your_turn"
            BOT["error"] = "Bot selected an illegal move."

            publish_bot(
                "bot_error",
                {"error": BOT["error"]},
            )
            return

        candidate = board.copy()
        candidate.push(move)

        info = move_info(board, move)

        BOT["pending_bot_move"] = {
            "info": info,
            "expected_fen": candidate.fen(),
        }
        BOT["phase"] = "replicate_bot_move"
        BOT["error"] = None

        payload = {
            "move": info,
            "expectedFen": candidate.fen(),
        }

    publish_bot("bot_move_pending", payload)

    led_safe(
        "game_highlight",
        None,
        None,
        bot_led_square(info["from"]),
        bot_led_square(info["to"]),
    )


def save_finished_bot_game(game_id):
    with lock:
        if BOT["game_id"] != game_id:
            return

        game = chess.pgn.Game()
        game.headers["Event"] = "HallGrid Bot Game"
        game.headers["Site"] = "HallGrid"
        game.headers["Date"] = time.strftime("%Y.%m.%d")

        if BOT["winner"] == "white":
            game.headers["Result"] = "1-0"
        elif BOT["winner"] == "black":
            game.headers["Result"] = "0-1"
        else:
            game.headers["Result"] = "1/2-1/2"

        node = game
        board = chess.Board(BOT["initial_fen"])

        for uci in BOT["moves"]:
            move = chess.Move.from_uci(uci)
            node = node.add_variation(move)
            board.push(move)

        exporter = chess.pgn.StringExporter(
            headers=True,
            variations=False,
            comments=False,
        )
        pgn_text = game.accept(exporter)

        upsert_game(
            game_id=BOT["game_id"],
            mode="bot",
            player_color=BOT["player_color"],
            bot_elo=BOT["bot_elo"],
            initial_fen=BOT["initial_fen"],
            moves=BOT["moves"],
            sans=BOT["sans"],
            status=BOT["status"],
            winner=BOT["winner"],
            pgn=pgn_text,
        )


def is_starting_position(placement):
    return placement == chess.Board().board_fen()


def bot_initial_position_detected():
    with lock:
        if (
            not BOT["game_id"]
            or BOT["phase"] != "waiting_for_pieces"
        ):
            return

        BOT["phase"] = (
            "your_turn"
            if BOT["player_color"] == "white"
            else "bot_thinking"
        )

        snapshot = bot_snapshot()

    publish_bot("bot_ready", snapshot)

    led_safe("ready")

    if BOT["phase"] == "bot_thinking":
        background(run_bot_turn)


def finish_bot_game_and_save():
    with lock:
        if BOT["phase"] != "game_over":
            return

        snapshot = bot_snapshot()
        game_id = BOT["game_id"]

    publish_bot("bot_game_over", snapshot)

    background(save_finished_bot_game, game_id)

    if BOT["winner"] == BOT["player_color"]:
        led_game_over("white_win")
    elif BOT["winner"] is None:
        led_game_over("draw")
    else:
        led_game_over("black_win")


@socketio.on("update_bot_board")
def handle_update_bot_board(data):
    try:
        if not isinstance(data, dict):
            raise ValueError("Expected an object containing 'fen'.")

        fen = data.get("fen")

        if not isinstance(fen, str):
            raise ValueError("Missing FEN string.")

        observed = chess.Board(fen)
        placement = observed.board_fen()

    except (ValueError, TypeError) as exc:
        publish_bot(
            "bot_board_rejected",
            {"reason": str(exc)},
            to=request.sid,
        )
        led_safe("illegal")
        return

    error = None
    unchanged = False
    user_move_confirmed = None
    bot_move_confirmed = None
    checked_king_square = None
    bot_checked_king_square = None

    with lock:
        if (
            BOT["phase"] in {
                "your_turn",
                "replicate_bot_move",
            }
            and BOT["last_confirmed_placement"] == placement
        ):
            unchanged = True

        if BOT["phase"] == "game_over":
            error = "The bot game is already over."

        elif BOT["phase"] == "waiting_for_pieces":
            if is_starting_position(placement):
                BOT["board"] = chess.Board()
                BOT["last_confirmed_placement"] = placement
                BOT["error"] = None

                background(bot_initial_position_detected)
                return

            error = (
                "Place all pieces in the standard starting position."
            )

        elif BOT["phase"] == "bot_thinking":
            error = "Bot is thinking. Please wait."

        else:
            board = BOT["board"]

            if placement == board.board_fen():
                unchanged = True

            elif BOT["phase"] == "replicate_bot_move":
                pending = BOT["pending_bot_move"]

                if pending is None:
                    error = "No pending bot move."
                else:
                    expected = chess.Board(
                        pending["expected_fen"]
                    )

                    if placement != expected.board_fen():
                        error = (
                            "Reproduce the highlighted bot move first. "
                            "Expected placement: "
                            f"{expected.board_fen()}"
                        )
                    else:
                        bot_move_confirmed = pending["info"]

                        BOT["last_confirmed_placement"] = (
                            expected.board_fen()
                        )
                        BOT["board"] = expected
                        BOT["moves"].append(
                            pending["info"]["uci"]
                        )
                        BOT["sans"].append(
                            pending["info"]["san"]
                        )
                        BOT["pending_bot_move"] = None
                        BOT["error"] = None

                        if BOT["board"].is_check():
                            bot_checked_king_square = (
                                chess.square_name(
                                    BOT["board"].king(
                                        BOT["board"].turn
                                    )
                                )
                            )

                        result = finish_bot_locked()

                        if result is None:
                            BOT["phase"] = "your_turn"
                        else:
                            BOT["phase"] = "game_over"

            elif BOT["phase"] == "your_turn":
                matches = []

                for move in board.legal_moves:
                    candidate = board.copy()
                    candidate.push(move)

                    if candidate.board_fen() == placement:
                        matches.append((move, candidate))

                if len(matches) != 1:
                    error = (
                        "Position is not exactly one legal move ahead "
                        "of the backend position. Backend: "
                        f"{board.fen()} Observed: {placement}"
                    )
                else:
                    move, candidate = matches[0]
                    info = move_info(board, move)

                    BOT["last_confirmed_placement"] = (
                        board.board_fen()
                    )
                    BOT["board"] = candidate
                    BOT["moves"].append(move.uci())
                    BOT["sans"].append(info["san"])
                    BOT["error"] = None

                    user_move_confirmed = info

                    if candidate.is_check():
                        king_square = chess.square_name(
                            candidate.king(
                                candidate.turn
                            )
                        )

                        checked_king_square = king_square

                    result = finish_bot_locked()

                    if result is None:
                        BOT["phase"] = "bot_thinking"
                    else:
                        BOT["phase"] = "game_over"

    if error:
        publish_bot(
            "bot_board_rejected",
            {"reason": error},
            to=request.sid,
        )
        led_safe("illegal")
        return

    if unchanged:
        last_from = None
        last_to = None

        if BOT["moves"]:
            last_uci = BOT["moves"][-1]
            last_move = chess.Move.from_uci(last_uci)

            last_from = chess.square_name(
                last_move.from_square
            )
            last_to = chess.square_name(
                last_move.to_square
            )

        pending_from = None
        pending_to = None

        pending = BOT["pending_bot_move"]

        if pending:
            pending_info = pending["info"]

            pending_from = pending_info["from"]
            pending_to = pending_info["to"]

        if pending_from and pending_to:
            led_safe(
                "game_highlight",
                bot_led_square(last_from),
                bot_led_square(last_to),
                bot_led_square(pending_from),
                bot_led_square(pending_to),
            )

        elif last_from and last_to:
            led_safe(
                "last",
                bot_led_square(last_from),
                bot_led_square(last_to),
            )

        else:
            led_safe("normal")

        publish_bot(to=request.sid)
        return

    if user_move_confirmed:
        is_checkmate = (
            BOT["phase"] == "game_over"
            and BOT["status"] == "checkmate"
        )

        publish_bot(
            "bot_move_confirmed",
            {
                "fen": BOT["board"].fen(),
                "turn": (
                    "white"
                    if BOT["board"].turn
                    else "black"
                ),
                "lastMove": {
                    "from": user_move_confirmed["from"],
                    "to": user_move_confirmed["to"],
                },
                "sanMove": user_move_confirmed["san"],
                "check": (
                    checked_king_square
                    if not is_checkmate
                    else None
                ),
            },
        )

        if not is_checkmate:
            led_safe(
                "last",
                bot_led_square(user_move_confirmed["from"]),
                bot_led_square(user_move_confirmed["to"]),
        )

            if checked_king_square:
                led_safe(
                    "check",
                    bot_led_square(checked_king_square),
                )

        publish_bot()

        if BOT["phase"] == "bot_thinking":
            background(run_bot_turn)

        elif BOT["phase"] == "game_over":
            finish_bot_game_and_save()

    if bot_move_confirmed:
        is_checkmate = (
            BOT["phase"] == "game_over"
            and BOT["status"] == "checkmate"
        )

        publish_bot(
            "bot_move_confirmed",
            {
                "fen": BOT["board"].fen(),
                "turn": (
                    "white"
                    if BOT["board"].turn
                    else "black"
                ),
                "lastMove": {
                    "from": bot_move_confirmed["from"],
                    "to": bot_move_confirmed["to"],
                },
                "sanMove": bot_move_confirmed["san"],
                "check": (
                    bot_checked_king_square
                    if not is_checkmate
                    else None
                ),
            },
        )

        if not is_checkmate:
            led_safe(
                "last",
                bot_led_square(bot_move_confirmed["from"]),
                bot_led_square(bot_move_confirmed["to"]),
            )

            if bot_checked_king_square:
                led_safe(
                    "check",
                    bot_led_square(bot_checked_king_square),
                )

        publish_bot()

        if BOT["phase"] == "game_over":
            finish_bot_game_and_save()
@socketio.on("resign_bot_game")
def handle_resign_bot_game(data=None):
    data = data or {}

    with lock:
        if (
            not BOT["game_id"]
            or BOT["game_id"] != data.get("gameId")
        ):
            return {"error": "No matching bot game."}

        if BOT["phase"] == "game_over":
            return {"error": "This game has already ended."}

        BOT["phase"] = "game_over"
        BOT["status"] = "resign"
        BOT["winner"] = BOT["bot_color"]
        BOT["pending_bot_move"] = None
        BOT["error"] = None

        try:
            save_finished_bot_game(BOT["game_id"])
        except Exception:
            app.logger.exception(
                "Failed to save resigned bot game"
            )
            BOT["error"] = (
                "Game ended, but saving it to history failed."
            )

        snapshot = bot_snapshot()

    publish_bot("bot_game_over", snapshot)

    if BOT["winner"] == BOT["player_color"]:
        led_game_over("white_win")
    elif BOT["winner"] is None:
        led_game_over("draw")
    else:
        led_game_over("black_win")

    return {"status": "ok"}


@socketio.on("get_bot_session")
def handle_get_bot_session(data=None):
    publish_bot(to=request.sid)



def casual_led_square(square):
    if not square:
        return None
    return rush_led_square(square, CASUAL.get("player_color", "white"))


@socketio.on("start_casual_game")
def handle_start_casual_game(data=None):
    print("CASUAL START REQUEST RECEIVED:", data)
    data = data or {}

    try:
        time_limit = int(data.get("timeLimit", 300))
        increment = int(data.get("increment", 0))
        color = data.get("color", "white")
    except (TypeError, ValueError):
        return {
            "error": "Invalid casual game configuration."
        }

    if time_limit <= 0:
        return {
            "error": "Time limit must be greater than zero."
        }

    if increment < 0:
        increment = 0

    if color not in {"white", "black", "random"}:
        color = "white"

    if color == "random":
        color = "white" if random.random() < 0.5 else "black"

    with lock:
        CASUAL.update({
            "game_id": f"casual-{uuid.uuid4().hex[:10]}",
            "phase": "waiting_for_pieces",
            "board": chess.Board(),
            "moves": [],
            "sans": [],
            "player_color": color,
            "initial_fen": chess.STARTING_FEN,
            "time_limit_seconds": time_limit,
            "increment_seconds": increment,
            "white_ms": time_limit * 1000,
            "black_ms": time_limit * 1000,
            "turn_started_at": None,
            "status": None,
            "winner": None,
            "error": None,
            "last_confirmed_placement": None,
        })

        snapshot = casual_snapshot()

    publish_casual(
        "casual_game_started",
        {
            **snapshot,
            "playerColor": color,
        },
    )

    background(casual_intro_sequence)

    return {
        "status": "ok",
        "gameId": CASUAL["game_id"],
    }





@socketio.on("get_casual_session")
def handle_get_casual_session(data=None):
    publish_casual(to=request.sid)



def casual_initial_position_detected():
    with lock:
        if (
            not CASUAL["game_id"]
            or CASUAL["phase"] != "waiting_for_pieces"
        ):
            return

        CASUAL["phase"] = "your_turn"
        CASUAL["turn_started_at"] = time.time()

        snapshot = casual_snapshot()

    publish_casual("casual_ready", snapshot)

    led_safe("ready")




@socketio.on("update_casual_board")
def handle_update_casual_board(data):
    try:
        if not isinstance(data, dict):
            raise ValueError("Expected an object containing 'fen'.")

        fen = data.get("fen")

        if not isinstance(fen, str):
            raise ValueError("Missing FEN string.")

        observed = chess.Board(fen)
        placement = observed.board_fen()

    except (ValueError, TypeError) as exc:
        publish_casual(
            "casual_board_rejected",
            {"reason": str(exc)},
            to=request.sid,
        )
        led_safe("illegal")
        return

    confirmed_move = None
    error = None
    unchanged = False
    checked_king_square = None
    casual_checkmate = False

    with lock:
        if CASUAL["phase"] == "game_over":
            error = "The casual game is already over."

        elif CASUAL["phase"] == "waiting_for_pieces":
            if placement == chess.Board().board_fen():
                CASUAL["board"] = chess.Board()
                CASUAL["last_confirmed_placement"] = placement
                CASUAL["error"] = None

                background(casual_initial_position_detected)
                return

            error = (
                "Place all pieces in the standard starting position."
            )

        elif CASUAL["phase"] != "your_turn":
            error = "No casual game is active."

        else:
            board = CASUAL["board"]

            print("\n--- CASUAL MOVE DEBUG ---")
            print("Backend board:", board.fen())
            print("Observed placement:", placement)
            print("Observed full FEN:", fen)

            if placement == board.board_fen():
                unchanged = True

            elif CASUAL.get("last_confirmed_placement") == placement:
                unchanged = True

            else:
                matches = []

                for move in board.legal_moves:
                    candidate = board.copy()
                    candidate.push(move)

                    if candidate.board_fen() == placement:
                        matches.append((move, candidate))

                if len(matches) == 1:
                    move, candidate = matches[0]

                    now = time.time()
                    elapsed_ms = 0

                    if CASUAL["turn_started_at"] is not None:
                        elapsed_ms = max(
                            0,
                            int(
                                (
                                    now - CASUAL["turn_started_at"]
                                ) * 1000
                            ),
                        )

                    if board.turn:
                        CASUAL["white_ms"] = max(
                            0,
                            CASUAL["white_ms"] - elapsed_ms,
                        )
                        CASUAL["white_ms"] += (
                            CASUAL["increment_seconds"] * 1000
                        )
                    else:
                        CASUAL["black_ms"] = max(
                            0,
                            CASUAL["black_ms"] - elapsed_ms,
                        )
                        CASUAL["black_ms"] += (
                            CASUAL["increment_seconds"] * 1000
                        )

                    info = move_info(board, move)

                    CASUAL["last_confirmed_placement"] = (
                        board.board_fen()
                    )

                    CASUAL["board"] = candidate
                    CASUAL["moves"].append(move.uci())
                    CASUAL["sans"].append(info["san"])
                    CASUAL["turn_started_at"] = now
                    CASUAL["error"] = None

                    confirmed_move = info

                    if candidate.is_check():
                        checked_king_square = chess.square_name(
                            candidate.king(
                                candidate.turn
                            )
                        )

                    background(
                        analyse_and_publish_eval,
                        candidate.fen(),
                        CASUAL["game_id"],
                        "casual",
                    )

                    result = finish_casual_locked()

                    if result is None:
                        CASUAL["phase"] = "your_turn"
                    else:
                        CASUAL["phase"] = "game_over"
                        CASUAL["turn_started_at"] = None

                        if CASUAL["status"] == "checkmate":
                            casual_checkmate = True

                else:
                    error = (
                        "Position is not exactly one legal move ahead of "
                        f"the backend position. Backend: {board.fen()} "
                        f"Observed: {placement}"
                    )

    if error:
        publish_casual(
            "casual_board_rejected",
            {"reason": error},
            to=request.sid,
        )
        led_safe("illegal")
        return

    if unchanged:
        last_from = None
        last_to = None

        if CASUAL["moves"]:
            last_uci = CASUAL["moves"][-1]
            last_move = chess.Move.from_uci(last_uci)

            last_from = chess.square_name(
                last_move.from_square
            )
            last_to = chess.square_name(
                last_move.to_square
            )

        if last_from and last_to:
            led_safe(
                "last",
                casual_led_square(last_from),
                casual_led_square(last_to),
            )
        else:
            led_safe("normal")

        publish_casual(to=request.sid)
        return

    publish_casual(
        "casual_move_confirmed",
        {
            "lastMove": {
                "from": confirmed_move["from"],
                "to": confirmed_move["to"],
            },
            "sanMove": confirmed_move["san"],
            "check": (
                checked_king_square
                if not casual_checkmate
                else None
            ),
        },
    )

    if casual_checkmate:
        background(
            save_finished_casual_game,
            CASUAL["game_id"],
        )

        publish_casual("casual_game_over")

        led_game_over(
            casual_result_to_led(CASUAL["winner"])
        )

        return

    led_safe(
        "last",
        casual_led_square(confirmed_move["from"]),
        casual_led_square(confirmed_move["to"]),
    )

    if checked_king_square:
        led_safe(
            "check",
            casual_led_square(checked_king_square),
        )

    publish_casual()

    if CASUAL["phase"] == "game_over":
        background(
            save_finished_casual_game,
            CASUAL["game_id"],
        )
        publish_casual("casual_game_over")

        led_game_over(
            casual_result_to_led(CASUAL["winner"])
        )





def save_finished_casual_game(game_id):
    with lock:
        if CASUAL["game_id"] != game_id:
            return

        game = chess.pgn.Game()
        game.headers["Event"] = "HallGrid Casual Game"
        game.headers["Site"] = "HallGrid"
        game.headers["Date"] = time.strftime("%Y.%m.%d")

        if CASUAL["winner"] == "white":
            game.headers["Result"] = "1-0"
        elif CASUAL["winner"] == "black":
            game.headers["Result"] = "0-1"
        elif CASUAL["status"]:
            game.headers["Result"] = "1/2-1/2"
        else:
            game.headers["Result"] = "*"

        node = game
        board = chess.Board(CASUAL["initial_fen"])

        for uci in CASUAL["moves"]:
            move = chess.Move.from_uci(uci)
            node = node.add_variation(move)
            board.push(move)

        exporter = chess.pgn.StringExporter(
            headers=True,
            variations=False,
            comments=False,
        )
        pgn_text = game.accept(exporter)

        upsert_game(
            game_id=CASUAL["game_id"],
            mode="casual",
            player_color=CASUAL.get("player_color"),
            bot_elo=None,
            initial_fen=CASUAL["initial_fen"],
            moves=CASUAL["moves"],
            sans=CASUAL["sans"],
            status=CASUAL["status"],
            winner=CASUAL["winner"],
            pgn=pgn_text,
        )



@socketio.on("update_board_observation")
def handle_update_board_observation(data):
    with lock:
        rush_active = (
            rush_session["active"]
            and rush_session["phase"] != "idle"
        )

        bot_active = (
            BOT["game_id"] is not None
            and BOT["phase"] not in {"idle", "game_over"}
        )

        casual_active = (
            CASUAL["game_id"] is not None
            and CASUAL["phase"] not in {"idle", "game_over"}
        )

        lichess_active = S["game_id"] is not None

    if rush_active:
        handle_update_rush_board(data)
        return

    if bot_active:
        handle_update_bot_board(data)
        return

    if casual_active:
        handle_update_casual_board(data)
        return

    if lichess_active:
        handle_lichess_board_update(data)
        return

    reject_board(
        "No active bot, casual, or Lichess game.",
        request.sid,
    )








@socketio.on("get_active_session")
def handle_get_active_session(data=None):
    with lock:
        casual_active = (
            CASUAL["game_id"] is not None
            and CASUAL["phase"] not in {"idle", "game_over"}
        )

    if casual_active:
        publish_casual(to=request.sid)
    else:
        publish_lichess(to=request.sid)


# =========================================================
# Local move -> Lichess
# =========================================================


# =========================================================
# Account event stream
# =========================================================

@app.post("/api/rush/confirm-piece")
def rush_confirm_piece_test():
    socketio.emit("rush_confirm_piece")
    return jsonify(status="sent")


@app.post("/api/rush/board-cleared")
def rush_board_cleared_test():
    socketio.emit("rush_board_cleared")
    return jsonify(status="sent")


@app.get("/api/led-match-failed-test")
def led_match_failed_test():
    led_safe("match_failed")
    return jsonify(status="sent", command="match_failed")

@app.post("/api/rush/test-correct")
def rush_test_correct():
    with lock:
        if not rush_session["active"]:
            return jsonify(
                error="Puzzle Rush is not active."
            ), 400

        if rush_session["phase"] != "waiting_for_user_move":
            return jsonify(
                error="Puzzle Rush is not waiting for a move."
            ), 400

        board = rush_session["board"]

        if rush_session["solution_index"] >= len(
            rush_session["solution_moves"]
        ):
            return jsonify(
                error="No user move is pending."
            ), 400

        expected_uci = rush_session["solution_moves"][
            rush_session["solution_index"]
        ]

        move = chess.Move.from_uci(expected_uci)

        if move not in board.legal_moves:
            return jsonify(
                error="Expected puzzle move is not legal."
            ), 400

        info = move_info(board, move)
        run_id = rush_session["run_id"]

        board.push(move)
        rush_session["solution_index"] += 1

        if rush_session["solution_index"] >= len(
            rush_session["solution_moves"]
        ):
            rush_session["puzzles_solved"] += 1
            rush_session["results"][
                rush_session["current_puzzle"]
            ] = "correct"
            puzzle_complete = True
        else:
            puzzle_complete = False

        rush_session["phase"] = "showing_feedback"

    led_safe(
    "rush_correct_move",
    rush_led_square(info["from"]),
    rush_led_square(info["to"]),
)

    publish_rush(
        "rush_move_result",
        {
            "correct": True,
            "playedMove": info,
        },
    )

    background(rush_after_correct_move, run_id, puzzle_complete)

    return jsonify(
        status="correct",
        move=info,
    )


@app.post("/api/rush/test-wrong")
def rush_test_wrong():
    with lock:
        if not rush_session["active"]:
            return jsonify(
                error="Puzzle Rush is not active."
            ), 400

        if rush_session["phase"] != "waiting_for_user_move":
            return jsonify(
                error="Puzzle Rush is not waiting for a move."
            ), 400

        board = rush_session["board"]

        if rush_session["solution_index"] >= len(
            rush_session["solution_moves"]
        ):
            return jsonify(
                error="No user move is pending."
            ), 400

        expected_uci = rush_session["solution_moves"][
            rush_session["solution_index"]
        ]

        expected_move = chess.Move.from_uci(expected_uci)
        expected_info = move_info(board, expected_move)

        played_move = None

        for move in board.legal_moves:
            if move != expected_move:
                played_move = move
                break

        if played_move is None:
            played_move = expected_move

        played_info = move_info(board, played_move)
        run_id = rush_session["run_id"]

        rush_session["strikes"] += 1
        rush_session["results"][
            rush_session["current_puzzle"]
        ] = "wrong"
        rush_session["phase"] = "showing_feedback"

    led_safe(
    "rush_wrong_move",
    rush_led_square(played_info["from"]),
    rush_led_square(played_info["to"]),
    rush_led_square(expected_info["from"]),
    rush_led_square(expected_info["to"]),
)

    publish_rush(
        "rush_move_result",
        {
            "correct": False,
            "playedMove": played_info,
            "expectedMove": expected_info,
            "strikes": rush_session["strikes"],
        },
    )

    background(rush_after_wrong_move, run_id)

    return jsonify(
        status="wrong",
        playedMove=played_info,
        expectedMove=expected_info,
        strikes=rush_session["strikes"],
    )

@app.get("/api/led-test")
def led_test():
    command = request.args.get("command", "normal")
    move_from = request.args.get("from", "e2")
    move_to = request.args.get("to", "e4")

    if command == "blank":
        led_safe("blank")
    elif command == "normal":
        led_safe("normal")
    elif command == "pending":
        led_safe("pending", move_from, move_to)
    elif command == "last":
        led_safe("last", move_from, move_to)
    elif command == "loading":
        led_safe("loading")
    elif command == "end":
        led_safe("end", "white_win")
    elif command == "off":
        led_safe("off")
    else:
        return jsonify(error="Unknown command"), 400

    return jsonify(status="sent", command=command)


@app.get("/api/led-board-control")
def led_board_control():
    command = request.args.get("command", "normal")

    last_from = request.args.get("lastFrom")
    last_to = request.args.get("lastTo")

    pending_from = request.args.get("pendingFrom")
    pending_to = request.args.get("pendingTo")

    result = request.args.get("result", "draw")
    animation = request.args.get("animation", "vibgyor")

    try:
        if command == "blank":
            led_safe("blank")

        elif command == "normal":
            led_safe("normal")

        elif command == "last":
            if not last_from or not last_to:
                return jsonify(
                    error="lastFrom and lastTo are required."
                ), 400

            led_safe("last", last_from, last_to)

        elif command == "pending":
            if not pending_from or not pending_to:
                return jsonify(
                    error="pendingFrom and pendingTo are required."
                ), 400

            led_safe("pending", pending_from, pending_to)

        elif command == "highlight":
            if not last_from or not last_to:
                return jsonify(
                    error="lastFrom and lastTo are required."
                ), 400

            led_safe(
                "game_highlight",
                last_from,
                last_to,
                pending_from,
                pending_to,
            )

        elif command == "loading":
            led_safe("loading", animation)

        elif command == "end":
            led_safe("end", result)

        elif command == "off":
            led_safe("off")

        else:
            return jsonify(error="Unknown command."), 400

    except Exception as exc:
        return jsonify(
            error=f"LED command failed: {exc}"
        ), 500

    return jsonify(
        status="sent",
        command=command,
        lastMove={
            "from": last_from,
            "to": last_to,
        } if last_from and last_to else None,
        pendingMove={
            "from": pending_from,
            "to": pending_to,
        } if pending_from and pending_to else None,
        result=result if command == "end" else None,
        animation=animation if command == "loading" else None,
    )


@app.get("/api/led-effect-test")
def led_effect_test():
    effect = request.args.get("effect", "loading")
    result = request.args.get("result", "white_win")

    if effect == "loading":
        led_safe("loading")
    elif effect == "loading_spiral":
        led_safe("loading", "spiral")
    elif effect == "loading_diagonal":
        led_safe("loading", "diagonal")
    elif effect == "loading_curtain":
        led_safe("loading", "curtain")
    elif effect == "loading_sparkle":
        led_safe("loading", "sparkle")
    elif effect == "end":
        led_safe("end", result)
    elif effect == "off":
        led_safe("off")
    elif effect == "normal":
        led_safe("normal")
    else:
        return jsonify(error="Unknown effect"), 400

    return jsonify(
        status="sent",
        effect=effect,
        result=result if effect == "end" else None,
    )


@app.get("/api/led-pending-test")
def led_pending_test():
    move_from = request.args.get("from", "e7")
    move_to = request.args.get("to", "e5")

    led_safe("pending", move_from, move_to)

    return jsonify(
        status="sent",
        command="pending",
        **{"from": move_from, "to": move_to}
    )


@app.get("/api/led-last-test")
def led_last_test():
    move_from = request.args.get("from", "e7")
    move_to = request.args.get("to", "e5")

    led_safe("last", move_from, move_to)

    return jsonify(
        status="sent",
        command="last",
        **{"from": move_from, "to": move_to}
    )


# =========================================================
# Matchmaking
# =========================================================


@app.get("/api/games")
def get_games():
    try:
        page = max(1, int(request.args.get("page", 1)))
        limit = min(
            50,
            max(1, int(request.args.get("limit", 20))),
        )
    except (TypeError, ValueError):
        return jsonify(error="Invalid pagination parameters."), 400

    offset = (page - 1) * limit

    conn = get_db()

    rows = conn.execute(
        """
        SELECT game_id, mode, player_color, bot_elo, opponent_username,
               status, winner, created_at, updated_at
        FROM games
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
        """,
        (limit, offset),
    ).fetchall()

    total_row = conn.execute(
        "SELECT COUNT(*) AS total FROM games"
    ).fetchone()

    conn.close()

    return jsonify(
        games=[
            {
                "gameId": row["game_id"],
                "mode": row["mode"],
                "playerColor": row["player_color"],
                "botElo": row["bot_elo"],
                "opponentUsername": row["opponent_username"],
                "status": row["status"],
                "winner": row["winner"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ],
        page=page,
        limit=limit,
        total=total_row["total"],
        hasMore=offset + len(rows) < total_row["total"],
    )


@app.get("/api/games/<game_id>")
def get_game_details(game_id):
    game = get_saved_game(game_id)

    if game is None:
        return jsonify(error="Game not found."), 404

    return jsonify(game)


@app.get("/api/games/<game_id>/pgn")
def get_saved_game_pgn(game_id):
    saved = get_saved_game(game_id)

    if saved is None:
        return jsonify(
            error="Saved game not found in the database."
        ), 404

    pgn_text = saved.get("pgn")

    if not pgn_text or not pgn_text.strip():
        try:
            board = chess.Board(saved["initialFen"])

            game = chess.pgn.Game()
            game.setup(board)

            game.headers["Event"] = (
                f"HallGrid {saved['mode'].title()} Game"
            )
            game.headers["Site"] = "HallGrid"

            if saved["mode"] == "bot":
                bot_name = f"Stockfish ({saved.get('botElo')})"

                if saved.get("playerColor") == "white":
                    game.headers["White"] = "Player"
                    game.headers["Black"] = bot_name
                else:
                    game.headers["White"] = bot_name
                    game.headers["Black"] = "Player"

            winner = saved.get("winner")
            status = saved.get("status")

            if winner == "white":
                result = "1-0"
            elif winner == "black":
                result = "0-1"
            elif status in {
                None, "", "created", "started", "aborted", "noStart"
            }:
                result = "*"
            else:
                result = "1/2-1/2"

            game.headers["Result"] = result

            node = game

            for uci in saved["moves"]:
                move = chess.Move.from_uci(uci)

                if move not in board.legal_moves:
                    raise ValueError(
                        f"Illegal move in saved game: {uci}"
                    )

                node = node.add_variation(move)
                board.push(move)

            pgn_text = game.accept(
                chess.pgn.StringExporter(
                    headers=True,
                    variations=False,
                    comments=False,
                )
            )

        except (ValueError, TypeError, KeyError) as exc:
            return jsonify(
                error=f"Could not reconstruct PGN: {exc}"
            ), 422

    return Response(
        pgn_text,
        mimetype="application/x-chess-pgn",
    )


@app.get("/api/bot/game/<game_id>/pgn")
def get_bot_game_pgn(game_id):
    with lock:
        if BOT["game_id"] != game_id:
            return jsonify(error="Bot game not found."), 404

        game = chess.pgn.Game()
        game.headers["Event"] = "HallGrid Bot Game"
        game.headers["Site"] = "HallGrid"
        game.headers["Date"] = time.strftime("%Y.%m.%d")
        game.headers["Round"] = "-"
        game.headers["White"] = (
            "Player" if BOT["player_color"] == "white" else "Stockfish"
        )
        game.headers["Black"] = (
            "Stockfish" if BOT["player_color"] == "white" else "Player"
        )

        if BOT["winner"] == "white":
            game.headers["Result"] = "1-0"
        elif BOT["winner"] == "black":
            game.headers["Result"] = "0-1"
        elif BOT["status"]:
            game.headers["Result"] = "1/2-1/2"
        else:
            game.headers["Result"] = "*"

        if BOT["status"] == "checkmate":
            game.headers["Termination"] = "Normal"
        elif BOT["status"]:
            game.headers["Termination"] = (
                BOT["status"].replace("_", " ").title()
            )

        node = game
        board = chess.Board(BOT["initial_fen"])

        for uci in BOT["moves"]:
            move = chess.Move.from_uci(uci)
            node = node.add_variation(move)
            board.push(move)

        exporter = chess.pgn.StringExporter(
            headers=True,
            variations=False,
            comments=False,
        )
        pgn_text = game.accept(exporter)

    return Response(
        pgn_text,
        mimetype="application/x-chess-pgn",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{game_id}.pgn"'
            )
        },
    )


@app.get("/api/casual/game/<game_id>/pgn")
def get_casual_game_pgn(game_id):
    with lock:
        if CASUAL["game_id"] != game_id:
            return jsonify(error="Casual game not found."), 404

        game = chess.pgn.Game()
        game.headers["Event"] = "HallGrid Casual Game"
        game.headers["Site"] = "HallGrid"
        game.headers["Date"] = time.strftime("%Y.%m.%d")
        game.headers["Round"] = "-"

        if CASUAL["winner"] == "white":
            game.headers["Result"] = "1-0"
        elif CASUAL["winner"] == "black":
            game.headers["Result"] = "0-1"
        elif CASUAL["status"]:
            game.headers["Result"] = "1/2-1/2"
        else:
            game.headers["Result"] = "*"

        if CASUAL["status"] == "checkmate":
            game.headers["Termination"] = "Normal"
        elif CASUAL["status"]:
            game.headers["Termination"] = (
                CASUAL["status"].replace("_", " ").title()
            )

        node = game

        board = chess.Board(CASUAL["initial_fen"])

        for uci in CASUAL["moves"]:
            move = chess.Move.from_uci(uci)
            node = node.add_variation(move)
            board.push(move)

        exporter = chess.pgn.StringExporter(
            headers=True, variations=False, comments=False
        )
        pgn_text = game.accept(exporter)

    return Response(
        pgn_text,
        mimetype="application/x-chess-pgn",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{game_id}.pgn"'
            )
        },
    )


@socketio.on("resign_casual_game")
def handle_resign_casual_game(data=None):
    data = data or {}

    with lock:
        if (
            not CASUAL["game_id"]
            or CASUAL["game_id"] != data.get("gameId")
        ):
            return {"error": "No matching casual game."}

        if CASUAL["phase"] == "game_over":
            return {"error": "This game has already ended."}

        resigning_color = (
            "white" if CASUAL["board"].turn == chess.WHITE else "black"
        )

        CASUAL["phase"] = "game_over"
        CASUAL["status"] = "resign"
        CASUAL["winner"] = (
            "black" if resigning_color == "white" else "white"
        )
        CASUAL["turn_started_at"] = None
        CASUAL["error"] = None

        try:
            save_finished_casual_game(CASUAL["game_id"])
        except Exception:
            app.logger.exception(
                "Failed to save resigned casual game"
            )
            CASUAL["error"] = (
                "Game ended, but saving it to history failed."
            )

        publish_casual("casual_game_over")

        led_game_over(
            casual_result_to_led(CASUAL["winner"])
        )

    return {"status": "ok"}

# =========================================================
# Startup
# =========================================================


if __name__ == "__main__":
    if not LICHESS_TOKEN:
        raise RuntimeError("Set LICHESS_TOKEN before running app.py.")

    initialise_account()
    ensure_account_listener()

    threading.Thread(
        target=run_casual_clock,
        daemon=True,
    ).start()

    socketio.run(
        app,
        host="0.0.0.0",
        port=5000,
        debug=True,
        use_reloader=False,
    )