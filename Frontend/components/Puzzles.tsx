"use client";

import { useEffect, useRef, useState } from "react";
import { Socket } from "socket.io-client";

type RushPhase =
    | "idle"
    | "scanning_initial_board"
    | "waiting_for_empty_board"
    | "loading_puzzle"
    | "placing_white_pieces"
    | "placing_black_pieces"
    | "puzzle_ready"
    | "waiting_for_user_move"
    | "waiting_for_opponent_move"
    | "showing_feedback"
    | "showing_score"
    | "puzzle_solved"
    | "strike_locked"
    | "rush_complete"
    | "error";

type PuzzleResult = "correct" | "wrong" | "unplayed";

type PlayerSide = "white" | "black";

type RushState = {
    phase: RushPhase;
    message: string;
    puzzlesSolved: number;
    strikes: number;
    totalPuzzles: number;
    currentPuzzle: number;
    results: PuzzleResult[];
    setupSquare: string | null;
    setupPiece: string | null;
    playerColor: PlayerSide;
};

const initialRushState: RushState = {
    phase: "idle",
    message: "Start Puzzle Rush to begin.",
    puzzlesSolved: 0,
    strikes: 0,
    totalPuzzles: 8,
    currentPuzzle: 0,
    results: Array<PuzzleResult>(8).fill("unplayed"),
    setupSquare: null,
    setupPiece: null,
    playerColor: "white",
};

interface PuzzlesProps {
    socket: Socket | null;
    isConnected: boolean;
}

export default function Puzzles({
    socket,
    isConnected,
}: PuzzlesProps) {
    const [activeMode, setActiveMode] = useState<
        "menu" | "rush"
    >("menu");

    const [rushState, setRushState] = useState<RushState>(
        initialRushState,
    );

    const socketRef = useRef<Socket | null>(null);

    useEffect(() => {
        if (!socket) return;

        socketRef.current = socket;

        const applyRushPayload = (data: Record<string, unknown>) => {
            setRushState((current) => {
                const nextTotal =
                    (data.totalPuzzles as number) ??
                    current.totalPuzzles;
                const nextResults = Array.isArray(data.results)
                    ? (data.results as PuzzleResult[])
                    : current.results;
                const incomingColor = data.playerColor;
                const nextColor: PlayerSide =
                    incomingColor === "white" || incomingColor === "black"
                        ? incomingColor
                        : current.playerColor;

                return {
                    ...current,
                    phase: (data.phase as RushPhase) ?? current.phase,
                    message:
                        (data.message as string) ?? current.message,
                    puzzlesSolved:
                        (data.puzzlesSolved as number) ??
                        current.puzzlesSolved,
                    strikes:
                        (data.strikes as number) ?? current.strikes,
                    totalPuzzles: nextTotal,
                    currentPuzzle:
                        (data.currentPuzzle as number) ??
                        current.currentPuzzle,
                    setupSquare:
                        (data.setupSquare as string | null) ??
                        current.setupSquare,
                    setupPiece:
                        (data.setupPiece as string | null) ??
                        current.setupPiece,
                    results: nextResults,
                    playerColor: nextColor,
                };
            });
        };

        const handlers: Record<
            string,
            (data: Record<string, unknown>) => void
        > = {
            rush_started: applyRushPayload,
            rush_state: applyRushPayload,
            rush_loading: applyRushPayload,
            rush_puzzle_loaded: applyRushPayload,
            rush_piece_prompt: applyRushPayload,
            rush_piece_confirmed: applyRushPayload,
            rush_puzzle_ready: applyRushPayload,
            rush_move_result: applyRushPayload,
            rush_opponent_move: applyRushPayload,
            rush_puzzle_complete: applyRushPayload,
            rush_next_puzzle: applyRushPayload,
            rush_strike: applyRushPayload,
            rush_complete: applyRushPayload,
            rush_ended: applyRushPayload,
        };

        const handleRushBoardRejected = (data: {
            reason?: string;
        }) => {
            setRushState((current) => ({
                ...current,
                message:
                    data.reason ??
                    "Board update was rejected.",
            }));
        };

        Object.entries(handlers).forEach(([event, handler]) => {
            socket.on(event, handler);
        });

        socket.on(
            "rush_board_rejected",
            handleRushBoardRejected,
        );

        return () => {
            Object.entries(handlers).forEach(([event, handler]) => {
                socket.off(event, handler);
            });

            socket.off(
                "rush_board_rejected",
                handleRushBoardRejected,
            );
        };
    }, [socket]);

    const startPuzzleRush = () => {
        if (!socketRef.current || !isConnected) return;

        setRushState({
            ...initialRushState,
            results: Array<PuzzleResult>(8).fill("unplayed"),
            phase: "scanning_initial_board",
            message: "Scanning board...",
        });

        socketRef.current.emit("rush_start", {
            totalPuzzles: 8,
            maxStrikes: 3,
        });
    };

    const endPuzzleRush = () => {
        if (!socketRef.current) return;

        socketRef.current.emit("rush_end");

        setRushState({
            ...initialRushState,
            results: Array<PuzzleResult>(8).fill("unplayed"),
            message: "Puzzle Rush ended.",
        });
    };

    const pieceName = (piece: string | null) => {
        if (!piece) return "";

        const names: Record<string, string> = {
            P: "Pawn",
            N: "Knight",
            B: "Bishop",
            R: "Rook",
            Q: "Queen",
            K: "King",
        };

        return names[piece.toUpperCase()] ?? piece;
    };

    const scoreSegments = Array.from(
        { length: rushState.totalPuzzles },
        (_, index) => {
            const res = rushState.results[index];
            if (res === "correct") return "solved";
            if (res === "wrong") return "strike";
            return "unreached";
        },
    );

    const completedCount = rushState.results.filter(
        (r) => r !== "unplayed",
    ).length;

    const isIdleOrDone =
        rushState.phase === "idle" ||
        rushState.phase === "rush_complete";

    const isPlacingPieces =
        rushState.phase === "placing_white_pieces" ||
        rushState.phase === "placing_black_pieces";

    return (
        <section id="drills" className="scr on">
            {activeMode === "menu" ? (
                <div className="puzzles-menu">
                    <h1 className="hd">Puzzles</h1>

                    <p className="mut">
                        Train with Puzzles and sharpen your game.
                    </p>

                    <div
                        className="list"
                        id="ol"
                        style={{ marginTop: "14px" }}
                    >
                        <button
                            className="card"
                            onClick={() => setActiveMode("rush")}
                        >
                            <i className="ic">
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    width="96"
                                    height="96"
                                    viewBox="0 0 96 96"
                                    fill="none"
                                    role="img"
                                    aria-labelledby="puzzle-rush-title"
                                    style={{
                                        width: "26px",
                                        height: "26px",
                                    }}
                                >
                                    <title id="puzzle-rush-title">
                                        Puzzle Rush
                                    </title>

                                    <path
                                        d="M43 13H59M51 13V23"
                                        stroke="#1a2f23"
                                        strokeWidth="5"
                                        strokeLinecap="round"
                                    />

                                    <path
                                        d="M72 24L78 30M75 27L70 32"
                                        stroke="#1a2f23"
                                        strokeWidth="5"
                                        strokeLinecap="round"
                                    />

                                    <path
                                        d="M26 35 A29 29 0 1 1 26 69"
                                        stroke="#1a2f23"
                                        strokeWidth="5"
                                        strokeLinecap="round"
                                    />

                                    <path
                                        d="M13 43H29M9 52H25M13 61H29"
                                        stroke="#1a2f23"
                                        strokeWidth="5"
                                        strokeLinecap="round"
                                    />

                                    <path
                                        d="M55 33 L37 55 H49 L45 73 L65 49 H53 L59 33 Z"
                                        fill="#1a2f23"
                                        stroke="#1a2f23"
                                        strokeWidth="2"
                                        strokeLinejoin="round"
                                    />
                                </svg>
                            </i>

                            <span style={{ flex: 1 }}>
                                <b>Puzzle Rush</b>

                                <span className="mut">
                                    Three strikes, eight puzzles
                                </span>
                            </span>

                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M9 6l6 6-6 6" />
                            </svg>
                        </button>
                    </div>
                </div>
            ) : (
                <div className="rush-screen">
                    <header className="rush-header">
                        <button
                            type="button"
                            className="rush-back"
                            onClick={() => setActiveMode("menu")}
                            aria-label="Back to Puzzles"
                        >
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                            >
                                <path d="M15 6l-6 6 6 6" />
                            </svg>
                        </button>

                        <div className="rush-title">
                            <h1 className="hd">Puzzle Rush</h1>

                            <span className="mut">
                                {isIdleOrDone
                                    ? "Survival · 8 puzzles · 3 strikes"
                                    : `Playing as ${
                                          rushState.playerColor === "black"
                                              ? "Black"
                                              : "White"
                                      } · 3 strikes`}
                            </span>
                        </div>
                    </header>

                    <div className="rush-card">
                        <div className="rush-progress">
                            <div className="rush-progress-top">
                                <span className="rush-label">
                                    Puzzle{" "}
                                    {Math.min(
                                        rushState.currentPuzzle + 1,
                                        rushState.totalPuzzles,
                                    )}{" "}
                                    of {rushState.totalPuzzles}
                                </span>

                                <span className="rush-strikes">
                                    {rushState.strikes} / 3 strikes
                                </span>
                            </div>

                            <div className="rush-progress-bar">
                                <span
                                    style={{
                                        width: `${Math.min(
                                            100,
                                            (completedCount /
                                                rushState.totalPuzzles) *
                                                100,
                                        )}%`,
                                    }}
                                />
                            </div>
                        </div>

                        <div className="rush-status">
                            <span className="rush-status-dot" />

                            <span className="rush-status-text">
                                {rushState.message}
                            </span>
                        </div>

                        {isPlacingPieces && (
                            <div className="rush-setup-box">
                                <span className="rush-label">
                                    Place{" "}
                                    {pieceName(rushState.setupPiece)}
                                </span>

                                <span className="rush-square-value">
                                    {rushState.setupSquare}
                                </span>
                            </div>
                        )}

                        <div className="rush-board-preview">
                            <div className="rush-mini-board">
                                {Array.from(
                                    { length: 16 },
                                    (_, index) => {
                                        const row = Math.floor(
                                            index / 4,
                                        );

                                        const column = index % 4;

                                        return (
                                            <span
                                                key={index}
                                                className={
                                                    (row + column) % 2 === 0
                                                        ? "rush-square rush-square-light"
                                                        : "rush-square rush-square-dark"
                                                }
                                            />
                                        );
                                    },
                                )}
                            </div>
                        </div>

                        <div className="rush-score">
                            <span className="rush-score-label">
                                Run progress
                            </span>

                            <div className="rush-score-strip">
                                {scoreSegments.map(
                                    (segment, index) => (
                                        <span
                                            key={index}
                                            className={`rush-score-segment rush-score-${segment}`}
                                        />
                                    ),
                                )}
                            </div>
                        </div>

                        <div className="rush-actions">
                            <button
                                type="button"
                                className="rush-action-button"
                                disabled={!isConnected || !socket}
                                onClick={
                                    isIdleOrDone
                                        ? startPuzzleRush
                                        : endPuzzleRush
                                }
                            >
                                {isIdleOrDone
                                    ? "Start Puzzle Rush"
                                    : "End Puzzle Rush"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <style>{`
        .puzzles-menu {
  display: flex;
  flex-direction: column;
}

.puzzles-menu h1 {
  margin: 0;
}

.puzzles-menu > .mut {
  margin: 6px 0 0;
}

.rush-screen {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.rush-header {
  display: flex;
  align-items: center;
  gap: 14px;
}

.rush-back {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 1px solid rgba(26, 47, 35, .12);
  border-radius: 12px;
  background: transparent;
  color: #1a2f23;
  cursor: pointer;
}

.rush-title h1 {
  margin: 0;
  font-size: 24px;
  line-height: 1.15;
  letter-spacing: -.7px;
}

.rush-card {
  padding: 20px;
  border: 1px solid rgba(26, 47, 35, .08);
  border-radius: 24px;
  background: #fffdf8;
  box-shadow: 0 8px 30px rgba(26, 47, 35, .035);
}

.rush-progress-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.rush-label {
  font-size: 11px;
  font-weight: 700;
  color: #1a2f23;
}

.rush-strikes {
  font-size: 10px;
  font-weight: 700;
  color: #788577;
}

.rush-progress-bar {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: rgba(26, 47, 35, .08);
  overflow: hidden;
}

.rush-progress-bar span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: #1a2f23;
  transition: width .35s ease;
}

.rush-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding: 11px 12px;
  border-radius: 12px;
  background: rgba(26, 47, 35, .04);
}

.rush-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #1a2f23;
  flex-shrink: 0;
}

.rush-status-text {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
}

.rush-setup-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 14px;
  padding: 12px;
  border-radius: 12px;
  background: rgba(148, 0, 211, .08);
}

.rush-square-value {
  font-size: 18px;
  font-weight: 800;
  color: #1a2f23;
}

.rush-board-preview {
  display: grid;
  place-items: center;
  margin: 20px 0;
}

.rush-mini-board {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  width: 108px;
  height: 108px;
  overflow: hidden;
  border-radius: 9px;
  opacity: .9;
}

.rush-square-light {
  background: #ede9dc;
}

.rush-square-dark {
  background: #8d9d87;
}

.rush-score-label {
  display: block;
  margin-bottom: 10px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.3px;
  color: #788577;
}

.rush-score-strip {
  display: flex;
  gap: 4px;
}

.rush-score-segment {
  flex: 1;
  height: 10px;
  border-radius: 4px;
  background: #d9d5c7;
}

.rush-score-solved {
  background: #4f9d63;
}

.rush-score-strike {
  background: #c0553b;
}

.rush-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 20px;
}

.rush-action-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 52px;
  padding: 14px 18px;
  border: 0;
  border-radius: 14px;
  background: #1a2f23;
  color: #fffdf8;
  font: inherit;
  font-size: 14px;
  font-weight: 650;
  cursor: pointer;
}

.rush-action-button:disabled {
  opacity: .5;
  cursor: not-allowed;
}
      `}</style>
        </section>
    );
}