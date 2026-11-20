import json
import threading
import serial


class LedBoard:
    def __init__(self, port, baudrate=115200):
        self.ser = serial.Serial(port, baudrate, timeout=1)
        self.lock = threading.Lock()

    def _send(self, payload):
        line = json.dumps(payload, separators=(",", ":")) + "\n"

        with self.lock:
            self.ser.write(line.encode("utf-8"))
            self.ser.flush()

    def blank(self):
        self._send({"cmd": "BLANK"})

    def normal(self):
        self._send({"cmd": "NORMAL"})

    def setup(self):
        self._send({"cmd": "SETUP"})

    def ready(self):
        self._send({"cmd": "READY"})

    def loading(self, animation="vibgyor", loop=False):
        self._send({
            "cmd": "LOADING",
            "animation": animation,
            "loop": loop,
        })

    def match_found(self):
        self._send({"cmd": "MATCH_FOUND"})

    def match_failed(self):
        self._send({"cmd": "MATCH_FAILED"})

    def game_highlight(
        self,
        last_from=None,
        last_to=None,
        pending_from=None,
        pending_to=None,
    ):
        self._send({
            "cmd": "GAME_HIGHLIGHT",
            "lastFrom": last_from,
            "lastTo": last_to,
            "pendingFrom": pending_from,
            "pendingTo": pending_to,
        })

    def check(self, king_square):
        self._send({
            "cmd": "CHECK",
            "kingSquare": king_square,
        })

    def illegal(self):
        self._send({"cmd": "ILLEGAL"})

    def pending(self, move_from, move_to):
        self._send({
            "cmd": "PENDING",
            "from": move_from,
            "to": move_to,
        })

    def last(self, move_from, move_to):
        self._send({
            "cmd": "LAST",
            "from": move_from,
            "to": move_to,
        })

    def end(self, result="draw"):
        self._send({
            "cmd": "END",
            "result": result,
        })

    def off(self):
        self._send({"cmd": "OFF"})

    # --- Scan Mode Command ---

    def scan_occupancy(self, squares=None):
        self._send({
            "cmd": "SCAN_OCCUPANCY",
            "squares": list(squares or []),
        })

    # --- Puzzle Rush Commands ---

    def rush_scan_wave(self):
        self._send({"cmd": "RUSH_SCAN_WAVE"})

    def rush_empty_required(self, squares=None):
        self._send({
            "cmd": "RUSH_EMPTY_REQUIRED",
            "squares": squares or [],
        })

    def rush_loading(self):
        self._send({"cmd": "RUSH_LOADING"})

    def rush_piece_prompt(self, squares, rgb):
        if isinstance(squares, str):
            squares = [squares]
        self._send({
            "cmd": "RUSH_PIECE_PROMPT",
            "squares": list(squares),
            "rgb": list(rgb),
        })

    def rush_puzzle_ready(self):
        self._send({"cmd": "RUSH_PUZZLE_READY"})

    def rush_correct_move(self, move_from, move_to):
        self._send({
            "cmd": "RUSH_CORRECT_MOVE",
            "from": move_from,
            "to": move_to,
        })

    def rush_wrong_move(
        self,
        played_from,
        played_to,
        correct_from,
        correct_to,
    ):
        self._send({
            "cmd": "RUSH_WRONG_MOVE",
            "playedFrom": played_from,
            "playedTo": played_to,
            "correctFrom": correct_from,
            "correctTo": correct_to,
        })

    def rush_score_strip(self, results):
        self._send({
            "cmd": "RUSH_SCORE_STRIP",
            "results": list(results),
        })

    def rush_opponent_move(self, move_from, move_to):
        self._send({
            "cmd": "RUSH_OPPONENT_MOVE",
            "from": move_from,
            "to": move_to,
        })

    def rush_over(self, completed):
        self._send({
            "cmd": "RUSH_OVER",
            "completed": bool(completed),
        })