from pathlib import Path
import threading
import time
import chess
import cv2
import socketio
from ultralytics import YOLO

HERE = Path(__file__).resolve().parent
BACKEND_URL = "http://127.0.0.1:5000"

# --- Model & Camera Tuning ---
MODEL1_WEIGHTS = HERE / "chessboxweights.pt"
MODEL2_WEIGHTS = HERE / "piece_finder_weights.pt"

CAMERA_INDEX = 0
FRAME_SLEEP_SEC = 0.05
IMGSZ_M1 = 640
CONF_M1 = 0.5
TOP_TRIM_RATIO = 0.03

IMGSZ_M2 = 640
CONF_M2 = 0.35

EMPTY_FRAMES_REQUIRED = 3


def crop_chessbox_exact(frame, model1):
    h, w = frame.shape[:2]
    results = model1.predict(
        source=frame, imgsz=IMGSZ_M1, conf=CONF_M1, verbose=False
    )[0]

    if len(results.boxes) == 0:
        return None

    best_idx = int(results.boxes.conf.argmax().item())
    x1, y1, x2, y2 = map(float, results.boxes.xyxy[best_idx].tolist())

    bh = y2 - y1
    top_trim_px = bh * TOP_TRIM_RATIO

    cx1 = max(0, int(round(x1)))
    cy1 = min(max(0, int(round(y1 + top_trim_px))), h - 1)
    cx2 = min(w, int(round(x2)))
    cy2 = min(h, int(round(y2)))

    crop = frame[cy1:cy2, cx1:cx2]
    if crop.size == 0:
        return None

    return crop


def anchor_to_grid_rc(ax, ay, cw, ch):
    img_col = min(7, max(0, int((ax / max(cw, 1)) * 8)))
    img_row = min(7, max(0, int((ay / max(ch, 1)) * 8)))

    occ_row = img_row
    occ_col = 7 - img_col
    return occ_row, occ_col


def analyze_crop_occupancy(crop, model2):
    ch, cw = crop.shape[:2]
    res2 = model2.predict(
        source=crop, imgsz=IMGSZ_M2, conf=CONF_M2, verbose=False
    )[0]

    occ = [["." for _ in range(8)] for _ in range(8)]

    for box in res2.boxes:
        conf = float(box.conf[0].item())
        if conf < CONF_M2:
            continue

        cls_id = int(box.cls[0].item())
        label = str(model2.names.get(cls_id, cls_id)).strip().lower()

        if label == "hand" or "hand" in label:
            return True, None

        if label == "piece" or "piece" in label:
            bx1, by1, bx2, by2 = map(float, box.xyxy[0].tolist())
            ax = 0.5 * (bx1 + bx2)
            ay = by2
            occ_row, occ_col = anchor_to_grid_rc(ax, ay, cw, ch)
            occ[occ_row][occ_col] = "X"

    return False, occ


def occ_rc_to_chess_square(occ_row: int, occ_col: int, perspective: str) -> int:
    if perspective == "w":
        chess_rank = occ_row
        chess_file = 7 - occ_col
    else:
        chess_rank = 7 - occ_row
        chess_file = occ_col
    return chess.square(chess_file, chess_rank)


def occ_to_square_names(occ, perspective: str) -> list[str]:
    squares = []
    for r in range(8):
        for c in range(8):
            if occ[r][c] == "X":
                sq = occ_rc_to_chess_square(r, c, perspective)
                squares.append(chess.square_name(sq))
    squares.sort()
    return squares


def board_to_occupancy(board: chess.Board, perspective: str):
    return [
        [
            "X" if board.piece_at(occ_rc_to_chess_square(r, c, perspective)) is not None else "."
            for c in range(8)
        ]
        for r in range(8)
    ]


def find_matching_legal_move(board: chess.Board, target_occ, perspective: str):
    for move in board.legal_moves:
        temp = board.copy()
        temp.push(move)
        if board_to_occupancy(temp, perspective) == target_occ:
            return move
    return None


def build_candidate_fen_from_occ(board: chess.Board, target_occ, perspective: str) -> str:
    fallback_symbol = "P" if board.turn == chess.WHITE else "p"
    fen_ranks = []

    for fen_rank_idx in range(8):
        chess_rank = 7 - fen_rank_idx
        empty_run = 0
        parts = []

        for chess_file in range(8):
            if perspective == "w":
                occ_row = chess_rank
                occ_col = 7 - chess_file
            else:
                occ_row = 7 - chess_rank
                occ_col = chess_file

            sq_occupied = target_occ[occ_row][occ_col] == "X"
            if not sq_occupied:
                empty_run += 1
            else:
                if empty_run > 0:
                    parts.append(str(empty_run))
                    empty_run = 0
                existing_piece = board.piece_at(chess.square(chess_file, chess_rank))
                parts.append(existing_piece.symbol() if existing_piece else fallback_symbol)

        if empty_run > 0:
            parts.append(str(empty_run))
        fen_ranks.append("".join(parts))

    turn_char = "w" if board.turn == chess.WHITE else "b"
    castling = board.castling_xfen() or "-"
    ep = chess.square_name(board.ep_square) if board.ep_square is not None else "-"
    return f"{'/'.join(fen_ranks)} {turn_char} {castling} {ep} {board.halfmove_clock} {board.fullmove_number}"


class ChessVisionController:
    def __init__(self, backend_url: str = BACKEND_URL):
        self.backend_url = backend_url
        self.sio = socketio.Client(reconnection=True)

        self._models_lock = threading.Lock()
        self.model1 = None
        self.model2 = None

        self._state_lock = threading.Lock()
        self.active_mode = None
        self.perspective = "w"
        self.board = chess.Board()
        self.valid_occ = None
        self.last_emitted_occ = None
        self.in_error_state = False

        # Puzzle Rush specific state
        self.rush_phase = "idle"
        self.rush_initial_scan_done = False
        self.rush_empty_streak = 0
        self.rush_last_occupied = None

        # Scan mode specific state
        self.scan_initial_done = False
        self.scan_last_occupied = None

        self._cam_lock = threading.Lock()
        self._cap = None
        self._stop_event = threading.Event()
        self._worker_thread = None

        self._register_socket_events()

    def _ensure_models_loaded(self):
        with self._models_lock:
            if self.model1 is None:
                if not MODEL1_WEIGHTS.exists():
                    raise FileNotFoundError(f"Missing Model 1 weights: {MODEL1_WEIGHTS}")
                self.model1 = YOLO(str(MODEL1_WEIGHTS), task="detect")
            if self.model2 is None:
                if not MODEL2_WEIGHTS.exists():
                    raise FileNotFoundError(f"Missing Model 2 weights: {MODEL2_WEIGHTS}")
                self.model2 = YOLO(str(MODEL2_WEIGHTS), task="detect")

    def _open_camera(self):
        with self._cam_lock:
            if self._cap is not None and self._cap.isOpened():
                return True
            cap = cv2.VideoCapture(CAMERA_INDEX)
            if not cap.isOpened():
                print(f"❌ Failed to open webcam index {CAMERA_INDEX}.")
                return False
            self._cap = cap
            print("📷 Webcam opened.")
            return True

    def close_camera(self):
        self._stop_event.set()
        thread = self._worker_thread
        if thread and thread.is_alive() and threading.current_thread() is not thread:
            thread.join(timeout=2.0)

        with self._cam_lock:
            if self._cap is not None:
                try:
                    self._cap.release()
                finally:
                    self._cap = None
                print("📷 Webcam closed and released.")

    def sync_fen(self, fen: str | None, perspective: str | None = None):
        if not fen:
            return
        with self._state_lock:
            try:
                self.board = chess.Board(fen)
                if perspective in ("w", "b"):
                    self.perspective = perspective
                synced_occ = board_to_occupancy(self.board, self.perspective)
                self.valid_occ = synced_occ
                self.last_emitted_occ = [row[:] for row in synced_occ]
                self.in_error_state = False
            except ValueError as exc:
                print(f"⚠️ Invalid FEN received ('{fen}'): {exc}")

    def start_mode(self, mode: str = "lichess", perspective: str | None = None):
        self._ensure_models_loaded()
        if not self._open_camera():
            return

        with self._state_lock:
            self.active_mode = mode
            if perspective in ("w", "b"):
                self.perspective = perspective
            if self.valid_occ is None:
                self.valid_occ = board_to_occupancy(self.board, self.perspective)
            if self.last_emitted_occ is None:
                self.last_emitted_occ = [row[:] for row in self.valid_occ]

        if self._worker_thread is None or not self._worker_thread.is_alive():
            self._stop_event.clear()
            self._worker_thread = threading.Thread(
                target=self._vision_loop, daemon=True
            )
            self._worker_thread.start()
            print(f"▶️ Mode '{mode}' started — vision loop active.")

    def stop_mode(self, reason: str = "mode ended"):
        with self._state_lock:
            prev_mode = self.active_mode
            self.active_mode = None
            self.rush_phase = "idle"
            self.scan_initial_done = False
            self.scan_last_occupied = None
        self.close_camera()
        if prev_mode:
            print(f"⏹️ Mode '{prev_mode}' stopped ({reason}).")

    def _emit_fen(self, fen_str: str, tag: str = ""):
        if not self.sio.connected:
            print("❌ Socket.IO not connected; cannot emit FEN.")
            return
        self.sio.emit("update_board_observation", {"fen": fen_str})
        prefix = f" ({tag})" if tag else ""
        print(f"📤 Emitted FEN{prefix}: {fen_str}")

    def _handle_scan_frame(self, occ, perspective):
        occupied = occ_to_square_names(occ, perspective)
        should_emit = False

        with self._state_lock:
            if not self.scan_initial_done or occupied != self.scan_last_occupied:
                self.scan_initial_done = True
                self.scan_last_occupied = list(occupied)
                should_emit = True

        if should_emit and self.sio.connected:
            self.sio.emit("scan_occupancy", {"occupiedSquares": occupied})

    def _handle_rush_frame(self, occ, perspective, board_snapshot, valid_occ, last_emitted):
        with self._state_lock:
            phase = self.rush_phase

        # 1. Initial scan & live piece removal
        if phase in {"scanning_initial_board", "waiting_for_empty_board"}:
            occupied = occ_to_square_names(occ, perspective)
            emit_occ = False
            emit_cleared = False

            with self._state_lock:
                if not self.rush_initial_scan_done or occupied != self.rush_last_occupied:
                    self.rush_initial_scan_done = True
                    self.rush_last_occupied = list(occupied)
                    emit_occ = True

                if len(occupied) == 0:
                    self.rush_empty_streak += 1
                    if self.rush_empty_streak >= EMPTY_FRAMES_REQUIRED:
                        emit_cleared = True
                        self.rush_phase = "loading_puzzle"
                        self.rush_empty_streak = 0
                else:
                    self.rush_empty_streak = 0

            if emit_occ and self.sio.connected:
                self.sio.emit("rush_occupancy", {"occupiedSquares": occupied})
            if emit_cleared and self.sio.connected:
                print("✅ Board empty for 3 frames -> emitting rush_board_cleared")
                self.sio.emit("rush_board_cleared")
            return

        # 2. Guided piece placement (White then Black)
        if phase in {"placing_white_pieces", "placing_black_pieces"}:
            occupied = occ_to_square_names(occ, perspective)
            with self._state_lock:
                changed = occupied != self.rush_last_occupied
                if changed:
                    self.rush_last_occupied = list(occupied)
            if changed and self.sio.connected:
                self.sio.emit("rush_occupancy", {"occupiedSquares": occupied})
            return

        # 3. Playing the puzzle (user move or opponent move)
        if phase in {"waiting_for_user_move", "waiting_for_opponent_move"}:
            if valid_occ is not None and occ == valid_occ:
                return
            if last_emitted is not None and occ == last_emitted:
                return

            matched_move = find_matching_legal_move(board_snapshot, occ, perspective)
            if matched_move is not None:
                board_snapshot.push(matched_move)
                new_fen = board_snapshot.fen()
                with self._state_lock:
                    self.board = board_snapshot
                    self.valid_occ = [row[:] for row in occ]
                    self.last_emitted_occ = [row[:] for row in occ]
                self._emit_fen(new_fen, tag=f"rush {phase}")

    def _vision_loop(self):
        while not self._stop_event.is_set():
            with self._state_lock:
                mode = self.active_mode
                if mode is None:
                    break
                perspective = self.perspective
                valid_occ = [row[:] for row in self.valid_occ] if self.valid_occ else None
                last_emitted = [row[:] for row in self.last_emitted_occ] if self.last_emitted_occ else None
                board_snapshot = self.board.copy()

            with self._cam_lock:
                cap = self._cap
                if cap is None or not cap.isOpened():
                    break
                ret, frame = cap.read()

            if not ret or frame is None:
                time.sleep(FRAME_SLEEP_SEC)
                continue

            crop = crop_chessbox_exact(frame, self.model1)
            if crop is None:
                time.sleep(FRAME_SLEEP_SEC)
                continue

            hand_detected, occ = analyze_crop_occupancy(crop, self.model2)
            if hand_detected or occ is None:
                time.sleep(FRAME_SLEEP_SEC)
                continue

            # Puzzle Rush branch
            if mode == "rush":
                self._handle_rush_frame(occ, perspective, board_snapshot, valid_occ, last_emitted)
                time.sleep(FRAME_SLEEP_SEC)
                continue

            # Scan mode branch
            if mode == "scan":
                self._handle_scan_frame(occ, perspective)
                time.sleep(FRAME_SLEEP_SEC)
                continue

            # Existing Lichess / Casual / Bot branch (unchanged)
            if valid_occ is not None and occ == valid_occ:
                with self._state_lock:
                    was_in_error = self.in_error_state
                    self.in_error_state = False
                    self.last_emitted_occ = [row[:] for row in valid_occ]
                    restored_fen = board_snapshot.fen()
                if was_in_error:
                    self._emit_fen(restored_fen, tag="restored/clear error")
                time.sleep(FRAME_SLEEP_SEC)
                continue

            if last_emitted is not None and occ == last_emitted:
                time.sleep(FRAME_SLEEP_SEC)
                continue

            matched_move = find_matching_legal_move(board_snapshot, occ, perspective)
            if matched_move is not None:
                board_snapshot.push(matched_move)
                new_fen = board_snapshot.fen()
                with self._state_lock:
                    self.board = board_snapshot
                    self.valid_occ = occ
                    self.last_emitted_occ = [row[:] for row in occ]
                    self.in_error_state = False
                self._emit_fen(new_fen, tag="legal move")
            else:
                candidate_fen = build_candidate_fen_from_occ(board_snapshot, occ, perspective)
                with self._state_lock:
                    self.last_emitted_occ = [row[:] for row in occ]
                    self.in_error_state = True
                self._emit_fen(candidate_fen, tag="unmatched/candidate")

            time.sleep(FRAME_SLEEP_SEC)

        self.close_camera()

    def _show_state(self, data):
        print(f"\n📋 Phase: {data.get('phase')}")
        if data.get("error"):
            print(f"⚠️ {data['error']}")
        if data.get("phase") == "syncing_initial_board":
            print("Initial FEN:", data.get("initialFen"))
        pending = data.get("pendingOpponentMove")
        if pending:
            print("💡 Reproduce opponent move:", pending.get("uci"), f"({pending.get('san')})")

    def _register_socket_events(self):
        sio = self.sio

        @sio.event
        def connect():
            print("✅ Connected to HallGrid backend.")

        @sio.event
        def disconnect():
            print("⚠️ Disconnected from backend.")

        # --- Scan Mode Socket Events ---
        @sio.on("scan_started")
        def on_scan_started(data=None):
            print("\n🔍 Scan Mode started — opening camera for initial scan.")
            with self._state_lock:
                self.scan_initial_done = False
                self.scan_last_occupied = None
            self.start_mode(mode="scan", perspective="w")

        @sio.on("scan_stopped")
        def on_scan_stopped(data=None):
            print("\n⏹️ Scan Mode stopped.")
            self.stop_mode(reason="scan_stopped")

        # --- Puzzle Rush Socket Events ---
        @sio.on("rush_started")
        def on_rush_started(data=None):
            print("\n⚡ Puzzle Rush started — opening camera for initial scan.")
            with self._state_lock:
                self.rush_phase = "scanning_initial_board"
                self.rush_initial_scan_done = False
                self.rush_empty_streak = 0
                self.rush_last_occupied = None
            self.start_mode(mode="rush", perspective="w")

        def _sync_rush_state(data):
            if not isinstance(data, dict):
                return
            phase = data.get("phase")
            fen = data.get("fen")
            player_color = data.get("playerColor")
            persp = (
                "b"
                if player_color == "black"
                else ("w" if player_color == "white" else None)
            )

            with self._state_lock:
                if phase:
                    self.rush_phase = phase
                if phase == "scanning_initial_board":
                    self.perspective = "w"
                    self.rush_initial_scan_done = False
                    self.rush_empty_streak = 0
                    self.rush_last_occupied = None
                elif phase == "waiting_for_empty_board":
                    self.perspective = "w"
                elif persp:
                    self.perspective = persp

                if phase in {
                    "placing_white_pieces",
                    "placing_black_pieces",
                    "waiting_for_opponent_move",
                }:
                    self.rush_last_occupied = None
                if phase == "waiting_for_user_move":
                    self.last_emitted_occ = None

            if fen and phase in {
                "rush_puzzle_ready",
                "puzzle_ready",
                "waiting_for_user_move",
                "waiting_for_opponent_move",
            }:
                self.sync_fen(fen, persp or self.perspective)

        for ev in (
            "rush_state",
            "rush_puzzle_loaded",
            "rush_piece_prompt",
            "rush_puzzle_ready",
            "rush_move_result",
            "rush_opponent_move",
            "rush_puzzle_complete",
            "rush_next_puzzle",
        ):
            sio.on(ev, _sync_rush_state)

        @sio.on("rush_complete")
        def on_rush_complete(data=None):
            print("\n🏁 Puzzle Rush complete.")
            self.stop_mode(reason="rush_complete")

        @sio.on("rush_ended")
        def on_rush_ended(data=None):
            print("\n⏹️ Puzzle Rush ended.")
            self.stop_mode(reason="rush_ended")

        # --- Existing Events (Unchanged) ---
        @sio.on("start_vision_mode")
        def on_start_vision_mode(data=None):
            payload = data or {}
            mode = payload.get("mode", "lichess")
            color = payload.get("color")
            perspective = "b" if str(color).lower().startswith("b") else ("w" if color else None)
            if payload.get("fen"):
                self.sync_fen(payload.get("fen"), perspective)
            self.start_mode(mode=mode, perspective=perspective)

        @sio.on("stop_vision_mode")
        def on_stop_vision_mode(data=None):
            reason = (data or {}).get("reason", "stop_vision_mode event")
            self.stop_mode(reason=reason)

        @sio.on("close_camera")
        def on_close_camera(_data=None):
            self.close_camera()

        @sio.on("session_snapshot")
        def on_session_snapshot(data):
            color = data.get("myColor")
            perspective = "b" if str(color).lower().startswith("b") else ("w" if color else None)
            self.sync_fen(data.get("fen") or data.get("initialFen"), perspective)
            self._show_state(data)

        @sio.on("match_found")
        def on_match_found(data):
            payload = data or {}
            color = payload.get("myColor")
            perspective = (
                "b" if str(color).lower().startswith("b") else "w"
            )
            fen = (
                payload.get("initialFen")
                or payload.get("fen")
                or chess.STARTING_FEN
            )
            print(
                f"\n🌐 Lichess match found (as {color or 'white'}) — opening camera."
            )
            self.sync_fen(fen, perspective)
            with self._state_lock:
                self.in_error_state = True
            self.start_mode(mode="lichess", perspective=perspective)
            self._show_state(payload)

        @sio.on("opponent_move_pending")
        def on_opponent_move_pending(data):
            self.sync_fen(data.get("fen"))
            self._show_state(data)

        @sio.on("game_state_update")
        def on_game_state_update(data):
            self.sync_fen(data.get("fen"))
            self._show_state(data)

        @sio.on("board_update_rejected")
        def on_board_update_rejected(data):
            if data.get("expectedFen"):
                self.sync_fen(data["expectedFen"])

        @sio.on("game_over")
        def on_game_over(data):
            self.stop_mode(reason="game_over")

        @sio.on("casual_session")
        def on_casual_session(data=None):
            payload = data or {}
            if payload.get("phase") in (None, "idle", "game_over"):
                return
            pcolor = str(payload.get("playerColor") or "white").lower()
            persp = "b" if pcolor.startswith("b") else "w"
            self.sync_fen(
                payload.get("fen") or payload.get("initialFen"),
                persp,
            )

        @sio.on("casual_game_started")
        def on_casual_game_started(data=None):
            payload = data or {}
            pcolor = str(payload.get("playerColor") or "white").lower()
            persp = "b" if pcolor.startswith("b") else "w"
            fen = (
                payload.get("fen")
                or payload.get("initialFen")
                or chess.STARTING_FEN
            )
            print(f"\n♟️ Casual game started (as {pcolor}) — opening camera.")
            self.sync_fen(fen, persp)
            with self._state_lock:
                self.in_error_state = True
            self.start_mode(mode="casual", perspective=persp)

        @sio.on("casual_move_confirmed")
        def on_casual_move_confirmed(data):
            if data.get("fen"):
                self.sync_fen(data["fen"])

        @sio.on("casual_board_rejected")
        def on_casual_board_rejected(data):
            if data.get("expectedFen"):
                self.sync_fen(data["expectedFen"])

        @sio.on("casual_game_over")
        def on_casual_game_over(data):
            self.stop_mode(reason="casual_game_over")

        # --- Bot Mode Socket Events ---
        @sio.on("bot_game_started")
        def on_bot_game_started(data=None):
            payload = data or {}
            pcolor = str(payload.get("playerColor") or "white").lower()
            persp = "b" if pcolor.startswith("b") else "w"
            fen = (
                payload.get("fen")
                or payload.get("initialFen")
                or chess.STARTING_FEN
            )
            print(f"\n🤖 Bot game started (as {pcolor}) — opening camera.")
            self.sync_fen(fen, persp)
            with self._state_lock:
                self.in_error_state = True
            self.start_mode(mode="bot", perspective=persp)

        @sio.on("bot_session")
        def on_bot_session(data=None):
            payload = data or {}
            if payload.get("phase") in (None, "idle", "game_over"):
                return
            pcolor = str(payload.get("playerColor") or "white").lower()
            persp = "b" if pcolor.startswith("b") else "w"
            self.sync_fen(
                payload.get("fen") or payload.get("initialFen"),
                persp,
            )

        @sio.on("bot_game_over")
        def on_bot_game_over(data=None):
            print("\n🏁 Bot game over.")
            self.stop_mode(reason="bot_game_over")

    def run_cli(self):
        try:
            self.sio.connect(self.backend_url)
        except Exception as exc:
            print(f"❌ Connection failed: {exc}")
            raise SystemExit(1)

        print(
            "\nHallGrid Vision Sender - Manual Override CLI\n"
            "Commands:\n"
            "  start lichess [w|b]  -> start mode & open webcam\n"
            "  start casual [w|b]   -> start casual mode & open webcam\n"
            "  start bot [w|b]      -> start bot mode & open webcam\n"
            "  stop                 -> end mode & close webcam\n"
            "  close                -> immediately close webcam\n"
            "  status               -> request current session\n"
            "  exit                 -> quit\n"
        )

        try:
            while True:
                raw = input("Vision > ").strip()
                if not raw:
                    continue
                parts = raw.lower().split()
                cmd = parts[0]
                if cmd == "exit":
                    break
                elif cmd == "close":
                    self.close_camera()
                elif cmd == "stop":
                    self.stop_mode(reason="manual stop")
                elif cmd == "status":
                    if self.sio.connected:
                        self.sio.emit("get_active_session")
                elif cmd == "start":
                    mode = parts[1] if len(parts) > 1 else "lichess"
                    if mode not in ("lichess", "casual", "bot"):
                        mode = "lichess"
                    persp = parts[2] if len(parts) > 2 and parts[2] in ("w", "b") else None
                    self.start_mode(mode=mode, perspective=persp)
                else:
                    print("Unknown command.")
        except (KeyboardInterrupt, EOFError):
            print("\nExiting...")
        finally:
            self.stop_mode(reason="shutdown")
            if self.sio.connected:
                self.sio.disconnect()


if __name__ == "__main__":
    ChessVisionController().run_cli()   