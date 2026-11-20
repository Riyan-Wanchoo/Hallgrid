"use client";


import { useRef, useState, useEffect } from "react";
import type { Socket } from "socket.io-client";
import Chessground from "@react-chess/chessground";
import { Chess } from "chess.js";
import type { Key } from "chessground/types";


import type {
    StartGameConfig,
    HallGridSession,
    HallGridClock,
} from "@/components/GameSetupModal";


interface PlayScreenProps {
    socket: Socket | null;
    mode: "main" | "bot" | "casual" | "lichess";
    setMode: (mode: "main" | "bot" | "casual" | "lichess") => void;
    isConnected: boolean;
    gameConfig: StartGameConfig | null;
}


export default function PlayScreen({
    socket,
    mode,
    setMode,
    isConnected,
    gameConfig,
}: PlayScreenProps) {
    const boardContainerRef = useRef<HTMLDivElement>(null);
    const [boardSize, setBoardSize] = useState<number>(360);


    const backendUrl =
        process.env.NEXT_PUBLIC_FLASK_URL ||
        "http://127.0.0.1:5000";


    const lichessGameUrl = gameConfig?.gameId
        ? `https://lichess.org/${gameConfig.gameId}`
        : null;


    const initialSession = gameConfig?.initialSession;


    const [session, setSession] = useState<HallGridSession | null>(
        initialSession ?? null
    );


    const [boardError, setBoardError] = useState<string | null>(null);


    const [endGameTitle, setEndGameTitle] = useState<string>("Game Over");


    const [game, setGame] = useState<Chess>(() => {
        return new Chess(initialSession?.displayFen);
    });


    const [fen, setFen] = useState<string>(() => {
        return initialSession?.displayFen ?? new Chess().fen();
    });


    const [turn, setTurn] = useState<"white" | "black">(() => {
        const board = new Chess(initialSession?.displayFen);
        return board.turn() === "w" ? "white" : "black";
    });


    const [playerColor, setPlayerColor] = useState<"white" | "black">(() => {
        if (gameConfig?.color === "black") {
            return "black";
        }
        return "white";
    });


    const boardOrientation = session?.myColor ?? playerColor;


    const initialTime = gameConfig?.timeLimit ?? 300;
    const [whiteTime, setWhiteTime] = useState<number>(initialTime);
    const [blackTime, setBlackTime] = useState<number>(initialTime);
    const [isGameOver, setIsGameOver] = useState<boolean>(false);


    const [isBotThinking, setIsBotThinking] = useState<boolean>(false);
    const [isWaitingForPieces, setIsWaitingForPieces] = useState<boolean>(false);
    const [showBestMove, setShowBestMove] = useState<boolean>(true);
    const [suggestedMove, setSuggestedMove] = useState<string>("-");
    const [moveHistory, setMoveHistory] = useState<string[]>([]);
    const [evalScore, setEvalScore] = useState<string>("+0.0");


    const [isResigning, setIsResigning] = useState(false);


    const [lastMove, setLastMove] = useState<
        { from: Key; to: Key } | null
    >(null);


    const [pendingMove, setPendingMove] = useState<
        { from: Key; to: Key } | null
    >(null);


    const moveHistoryContainerRef = useRef<HTMLDivElement>(null);


    const [isGameOverModalOpen, setIsGameOverModalOpen] = useState<boolean>(false);
    const [endGameReason, setEndGameReason] = useState<string>("");


    const [copied, setCopied] = useState<boolean>(false);


    useEffect(() => {
        if (moveHistoryContainerRef.current) {
            moveHistoryContainerRef.current.scrollTop =
                moveHistoryContainerRef.current.scrollHeight;
        }
    }, [moveHistory]);


    useEffect(() => {
        const updateSize = () => {
            if (boardContainerRef.current) {
                const width = boardContainerRef.current.clientWidth - 32;
                setBoardSize(Math.max(260, Math.min(width, 420)));
            }
        };

        updateSize();
        window.addEventListener("resize", updateSize);

        return () => window.removeEventListener("resize", updateSize);
    }, [mode]);


    useEffect(() => {
        if (mode === "bot" || mode === "casual" || mode === "lichess" || isGameOver) {
            return;
        }

        const timer = setInterval(() => {
            if (turn === "white") {
                setWhiteTime((prev) => (prev > 0 ? prev - 1 : 0));
            } else {
                setBlackTime((prev) => (prev > 0 ? prev - 1 : 0));
            }
        }, 1000);

        return () => clearInterval(timer);
    }, [turn, isGameOver, mode]);


    useEffect(() => {
        if (!socket || mode === "lichess") return;

        const handleGameStateUpdate = (data: {
            fen: string;
            turn: "white" | "black";
            lastMove?: { from: string; to: string };
            sanMove?: string;
            eval?: string;
            bestMove?: string;
            whiteTime?: number;
            blackTime?: number;
        }) => {
            if (data.fen) {
                setFen(data.fen);
                const newGame = new Chess(data.fen);
                setGame(newGame);

                if (newGame.isGameOver()) {
                    setIsGameOver(true);
                    setIsGameOverModalOpen(true);

                    if (newGame.isCheckmate()) {
                        const winner =
                            newGame.turn() === "w" ? "Black" : "White";

                        setEndGameReason(
                            `Checkmate! ${winner} wins.`
                        );
                    } else if (newGame.isStalemate()) {
                        setEndGameReason("Draw by stalemate.");
                    } else if (newGame.isDraw()) {
                        setEndGameReason("Game drawn.");
                    } else {
                        setEndGameReason("Game over.");
                    }
                }
            }

            if (data.turn) {
                setTurn(data.turn);
            }

            if (data.lastMove?.from && data.lastMove?.to) {
                setLastMove({
                    from: data.lastMove.from as Key,
                    to: data.lastMove.to as Key,
                });
            }

            if (data.sanMove) {
                setMoveHistory((prev) => [...prev, data.sanMove!]);
            }

            if (data.eval !== undefined) {
                setEvalScore(data.eval);
            }

            if (data.bestMove !== undefined) {
                setSuggestedMove(data.bestMove);
            }

            if (data.whiteTime !== undefined) {
                setWhiteTime(
                    data.whiteTime > 1000
                        ? Math.floor(data.whiteTime / 1000)
                        : data.whiteTime
                );
            }

            if (data.blackTime !== undefined) {
                setBlackTime(
                    data.blackTime > 1000
                        ? Math.floor(data.blackTime / 1000)
                        : data.blackTime
                );
            }
        };

        const handleEvalUpdate = (data: any) => {
            console.log("BOT/CASUAL EVAL UPDATE RECEIVED:", data);

            if (data.mode && data.mode !== mode) {
                return;
            }

            if (typeof data.mate === "number") {
                const sign = data.mate >= 0 ? "+" : "-";
                setEvalScore(`${sign}M${Math.abs(data.mate)}`);
                return;
            }

            if (typeof data.evalCp === "number") {
                const pawns = data.evalCp / 100;

                setEvalScore(
                    pawns > 0
                        ? `+${pawns.toFixed(1)}`
                        : pawns.toFixed(1)
                );
            }
        };

        socket.on("eval_update", handleEvalUpdate);
        socket.on("game_state_update", handleGameStateUpdate);

        return () => {
            socket.off("eval_update", handleEvalUpdate);
            socket.off("game_state_update", handleGameStateUpdate);
        };
    }, [socket, mode]);


    const terminalShownRef = useRef(false);


    useEffect(() => {
        if (!socket || mode !== "casual" || !gameConfig?.gameId) return;

        const gameId = gameConfig.gameId;

        const applyCasual = (data: any) => {
            if (data.gameId !== gameId) return;

            if (data.playerColor === "white" || data.playerColor === "black") {
                setPlayerColor(data.playerColor);
            }

            if (data.fen) {
                const board = new Chess(data.fen);

                setFen(data.fen);
                setGame(board);
                setTurn(board.turn() === "w" ? "white" : "black");
            }

            if (Array.isArray(data.sans)) {
                setMoveHistory(data.sans);
            }

            if (typeof data.whiteTimeMs === "number") {
                setWhiteTime(data.whiteTimeMs / 1000);
            }

            if (typeof data.blackTimeMs === "number") {
                setBlackTime(data.blackTimeMs / 1000);
            }

            if (data.phase === "waiting_for_pieces") {
                setIsWaitingForPieces(true);
                setIsBotThinking(false);
                setPendingMove(null);
                setLastMove(null);
                return;
            }

            setIsWaitingForPieces(false);
            setBoardError(null);

            if (data.phase === "game_over") {
                setIsGameOver(true);

                if (!terminalShownRef.current) {
                    terminalShownRef.current = true;

                    const winner = data.winner;
                    const status = data.status ?? "unknown";

                    let title = "Game Over";
                    let reason = "The game has ended.";

                    switch (status) {
                        case "checkmate":
                            title = "Checkmate";
                            reason = winner
                                ? `${winner === "white" ? "White" : "Black"} wins by checkmate.`
                                : "Checkmate.";
                            break;

                        case "stalemate":
                            title = "Draw";
                            reason = "Draw by stalemate.";
                            break;

                        case "insufficient_material":
                            title = "Draw";
                            reason = "Draw by insufficient material.";
                            break;

                        case "threefold_repetition":
                            title = "Draw";
                            reason = "Draw by threefold repetition.";
                            break;

                        case "fivefold_repetition":
                            title = "Draw";
                            reason = "Draw by fivefold repetition.";
                            break;

                        case "fifty_moves":
                            title = "Draw";
                            reason = "Draw by the fifty-move rule.";
                            break;

                        case "seventyfive_moves":
                            title = "Draw";
                            reason = "Draw by the seventy-five-move rule.";
                            break;

                        case "timeout":
                            title = "Timeout";
                            reason = winner
                                ? `${winner === "white" ? "White" : "Black"} wins on time.`
                                : "The game ended by timeout.";
                            break;

                        case "resign":
                            title = "Resignation";
                            reason = winner
                                ? `${winner === "white" ? "White" : "Black"} wins by resignation.`
                                : "A player resigned.";
                            break;

                        case "aborted":
                            title = "Game Aborted";
                            reason =
                                "The game was aborted before completion.";
                            break;

                        default:
                            title = "Game Over";
                            reason = `Game ended: ${status}.`;
                    }

                    setEndGameTitle(title);
                    setEndGameReason(reason);
                    setIsGameOverModalOpen(true);
                }
            }
        };

        const handleCasualMove = (data: any) => {
            if (data.gameId !== gameId) return;

            setBoardError(null);

            if (data.lastMove?.from && data.lastMove?.to) {
                setLastMove({
                    from: data.lastMove.from as Key,
                    to: data.lastMove.to as Key,
                });
            }
        };

        const handleCasualReady = (data: any) => {
            console.log("CASUAL READY RECEIVED:", data);

            if (data?.playerColor === "white" || data?.playerColor === "black") {
                setPlayerColor(data.playerColor);
            }

            setIsWaitingForPieces(false);
            setBoardError(null);

            if (data?.fen) {
                try {
                    const board = new Chess(data.fen);

                    setFen(data.fen);
                    setGame(board);
                    setTurn(board.turn() === "w" ? "white" : "black");
                } catch (err) {
                    console.error("Invalid casual FEN:", err);
                }
            }
        };

        const handleCasualClock = (data: any) => {
            if (data.gameId !== gameId) return;

            if (typeof data.whiteTimeMs === "number") {
                setWhiteTime(data.whiteTimeMs / 1000);
            }

            if (typeof data.blackTimeMs === "number") {
                setBlackTime(data.blackTimeMs / 1000);
            }
        };

        const handleCasualRejected = (data: any) => {
            setBoardError(data.reason || "Invalid board position.");
        };

        socket.on("casual_session", applyCasual);
        socket.on("casual_ready", handleCasualReady);
        socket.on("casual_move_confirmed", handleCasualMove);
        socket.on("casual_clock", handleCasualClock);
        socket.on("casual_board_rejected", handleCasualRejected);
        socket.on("casual_game_over", applyCasual);

        socket.emit("get_casual_session");

        return () => {
            socket.off("casual_session", applyCasual);
            socket.off("casual_ready", handleCasualReady);
            socket.off("casual_move_confirmed", handleCasualMove);
            socket.off("casual_clock", handleCasualClock);
            socket.off("casual_board_rejected", handleCasualRejected);
            socket.off("casual_game_over", applyCasual);
        };
    }, [socket, mode, gameConfig?.gameId]);


    useEffect(() => {
        if (!socket || mode !== "bot") return;

        const applyBotPosition = (fen: string) => {
            try {
                const board = new Chess(fen);

                setFen(fen);
                setGame(board);
                setTurn(board.turn() === "w" ? "white" : "black");
                setBoardError(null);
            } catch (err) {
                console.error("Invalid bot FEN:", err);
            }
        };

        const syncBotColor = (data: any) => {
            if (data?.playerColor === "white" || data?.playerColor === "black") {
                setPlayerColor(data.playerColor);
            }
        };

        const handleBotGameStarted = (data: any) => {
            console.log("BOT GAME STARTED RECEIVED:", data);

            syncBotColor(data);
            setIsWaitingForPieces(true);
            setIsBotThinking(false);
            setIsGameOver(false);
            setIsGameOverModalOpen(false);
            setIsResigning(false);
            setPendingMove(null);
            setLastMove(null);
            setMoveHistory([]);
            setSuggestedMove("-");
            setBoardError(null);

            if (data?.fen) {
                applyBotPosition(data.fen);
            }
        };

        const handleBotSession = (data: any) => {
            console.log("BOT SESSION RECEIVED:", data);

            if (!data?.fen) return;

            syncBotColor(data);

            if (data.phase === "waiting_for_pieces") {
                setIsWaitingForPieces(true);
                setIsBotThinking(false);
                setPendingMove(null);
                setLastMove(null);
                return;
            }

            setIsWaitingForPieces(false);

            if (data.phase === "bot_thinking") {
                setIsBotThinking(true);
                setPendingMove(null);
                applyBotPosition(data.fen);
                return;
            }

            if (data.phase === "replicate_bot_move") {
                setIsBotThinking(false);
                applyBotPosition(data.fen);

                const pending = data.pendingBotMove;

                if (pending?.info?.from && pending?.info?.to) {
                    setPendingMove({
                        from: pending.info.from as Key,
                        to: pending.info.to as Key,
                    });
                }

                return;
            }

            if (data.phase === "your_turn") {
                setIsBotThinking(false);
                setPendingMove(null);
            }

            applyBotPosition(data.fen);
        };

        const handleBotReady = (data: any) => {
            console.log("BOT READY RECEIVED:", data);

            syncBotColor(data);
            setIsWaitingForPieces(false);
            setIsBotThinking(false);
            setPendingMove(null);
            setBoardError(null);

            if (data?.fen) {
                applyBotPosition(data.fen);
            }
        };

        const handleBotMovePending = (data: any) => {
            console.log("BOT MOVE PENDING RECEIVED:", data);

            if (data.move?.from && data.move?.to) {
                setPendingMove({
                    from: data.move.from as Key,
                    to: data.move.to as Key,
                });
            }

            if (data.move?.san) {
                setSuggestedMove(data.move.san);
            }

            setIsBotThinking(false);
            setBoardError(null);
        };

        const handleBotMoveConfirmed = (data: any) => {
            console.log("BOT MOVE CONFIRMED RECEIVED:", data);

            if (data.fen) {
                applyBotPosition(data.fen);
            }

            if (data.lastMove?.from && data.lastMove?.to) {
                setLastMove({
                    from: data.lastMove.from as Key,
                    to: data.lastMove.to as Key,
                });
            }

            setPendingMove(null);
            setBoardError(null);

            if (data.sanMove) {
                setMoveHistory((prev) => [...prev, data.sanMove]);
            }
        };

        const handleBotBoardRejected = (data: any) => {
            console.log("BOT BOARD REJECTED RECEIVED:", data);

            setBoardError(
                data?.reason || "Invalid physical board position."
            );
        };

        const handleBotError = (data: any) => {
            console.log("BOT ERROR RECEIVED:", data);

            setIsBotThinking(false);
            setBoardError(
                data?.error || "Bot game error."
            );
        };

        const handleBotGameOver = (data: any) => {
            console.log("BOT GAME OVER RECEIVED:", data);

            syncBotColor(data);

            if (data?.fen) {
                applyBotPosition(data.fen);
            }

            const status = data?.status;
            const winner = data?.winner;

            let title = "Game Over";
            let reason = "The game has ended.";

            switch (status) {
                case "checkmate":
                    title = "Checkmate";
                    reason = winner
                        ? `${winner === "white" ? "White" : "Black"} wins by checkmate.`
                        : "Checkmate.";
                    break;

                case "stalemate":
                    title = "Draw";
                    reason = "Draw by stalemate.";
                    break;

                case "insufficient_material":
                    title = "Draw";
                    reason = "Draw by insufficient material.";
                    break;

                case "threefold_repetition":
                    title = "Draw";
                    reason = "Draw by threefold repetition.";
                    break;

                case "fivefold_repetition":
                    title = "Draw";
                    reason = "Draw by fivefold repetition.";
                    break;

                case "fifty_move_rule":
                    title = "Draw";
                    reason = "Draw by the fifty-move rule.";
                    break;

                case "seventyfive_move_rule":
                    title = "Draw";
                    reason = "Draw by the seventy-five-move rule.";
                    break;

                case "variant_end":
                    title = "Game Over";
                    reason = "The game ended by variant rule.";
                    break;

                case "resign":
                    title = "Resignation";
                    reason = winner
                        ? `${winner === "white" ? "White" : "Black"} wins by resignation.`
                        : "The game ended by resignation.";
                    break;

                default:
                    title = "Game Over";
                    reason = `Game ended: ${status ?? "unknown"}.`;
            }

            setPendingMove(null);
            setSuggestedMove("-");
            setIsBotThinking(false);
            setIsResigning(false);
            setBoardError(null);

            setEndGameTitle(title);
            setEndGameReason(reason);
            setIsGameOver(true);
            setIsGameOverModalOpen(true);
        };

        socket.on("bot_game_started", handleBotGameStarted);
        socket.on("bot_session", handleBotSession);
        socket.on("bot_ready", handleBotReady);
        socket.on("bot_move_pending", handleBotMovePending);
        socket.on("bot_move_confirmed", handleBotMoveConfirmed);
        socket.on("bot_board_rejected", handleBotBoardRejected);
        socket.on("bot_error", handleBotError);
        socket.on("bot_game_over", handleBotGameOver);

        socket.emit("get_bot_session");

        return () => {
            socket.off("bot_game_started", handleBotGameStarted);
            socket.off("bot_session", handleBotSession);
            socket.off("bot_ready", handleBotReady);
            socket.off("bot_move_pending", handleBotMovePending);
            socket.off("bot_move_confirmed", handleBotMoveConfirmed);
            socket.off("bot_board_rejected", handleBotBoardRejected);
            socket.off("bot_error", handleBotError);
            socket.off("bot_game_over", handleBotGameOver);
        };
    }, [socket, mode]);


    type LichessClockAnchor = HallGridClock & {
        anchorMs: number;
    };

    const lichessClockRef = useRef<LichessClockAnchor | null>(null);
    const [clockTurn, setClockTurn] = useState<
        "white" | "black" | null
    >(null);


    useEffect(() => {
        if (!socket || mode !== "lichess" || !gameConfig?.gameId) {
            return;
        }

        const gameId = gameConfig.gameId;

        const renderClock = () => {
            const clock = lichessClockRef.current;

            if (!clock) return;

            const elapsed = Math.max(
                0,
                performance.now() - clock.anchorMs
            );

            const remaining = (
                value: number | null | undefined,
                color: "white" | "black"
            ) => {
                if (typeof value !== "number") return null;

                const running =
                    clock.status === "started" &&
                    clock.runningColor === color;

                return Math.max(
                    0,
                    value - (running ? elapsed : 0)
                );
            };

            const white = remaining(clock.whiteMs, "white");
            const black = remaining(clock.blackMs, "black");

            if (white !== null) {
                setWhiteTime(white / 1000);
            }

            if (black !== null) {
                setBlackTime(black / 1000);
            }
        };

        const applyClock = (clock: HallGridClock) => {
            if (
                typeof clock.whiteMs !== "number" ||
                typeof clock.blackMs !== "number"
            ) {
                return;
            }

            const age =
                typeof clock.receivedAtMs === "number"
                    ? Math.max(
                        0,
                        Date.now() - clock.receivedAtMs
                    )
                    : 0;

            lichessClockRef.current = {
                ...clock,
                anchorMs: performance.now() - age,
            };

            setClockTurn(clock.runningColor ?? null);
            renderClock();
        };

        const applySession = (
            data: HallGridSession & {
                sanMove?: string | null;
                lastMove?: {
                    from: string;
                    to: string;
                } | null;
            }
        ) => {
            if (data.gameId !== gameId) return;



            if (data.phase === "waiting_for_pieces") {
                setIsWaitingForPieces(true);
                setIsBotThinking(false);
                setPendingMove(null);
                setLastMove(null);
                return;
            }

            setIsWaitingForPieces(false);

            setSession(data);

            if (data.clock) {
                applyClock(data.clock);
            }

            if (data.displayFen) {
                try {
                    const board = new Chess(data.displayFen);

                    setFen(data.displayFen);
                    setGame(board);
                    setTurn(
                        board.turn() === "w" ? "white" : "black"
                    );
                } catch (err) {
                    console.error("Invalid display FEN:", err);
                    setBoardError(
                        "Backend supplied an invalid display position."
                    );
                    return;
                }
            }

            const pending = data.pendingOpponentMove;

            setPendingMove(
                pending
                    ? {
                        from: pending.from as Key,
                        to: pending.to as Key,
                    }
                    : null
            );

            setBoardError(data.error || null);

            const terminal = Boolean(
                data.status &&
                data.status !== "created" &&
                data.status !== "started"
            );

            setIsGameOver(terminal);

            if (data.lastMove?.from && data.lastMove?.to) {
                setLastMove({
                    from: data.lastMove.from as Key,
                    to: data.lastMove.to as Key,
                });
            }

            if (data.sanMove) {
                setMoveHistory((previous) => [
                    ...previous,
                    data.sanMove as string,
                ]);
            }

            if (
                terminal &&
                !terminalShownRef.current
            ) {
                terminalShownRef.current = true;

                const status = data.status ?? "unknown";
                const winner = data.winner;

                let title = "Game Over";
                let reason = `Lichess game status: ${status}.`;

                if (status === "aborted") {
                    title = "Game Aborted";
                    reason =
                        "The game was aborted before completion.";
                } else if (status === "timeout") {
                    title = "Timeout";
                    reason = winner
                        ? `${winner === "white" ? "White" : "Black"} won on time.`
                        : "The game ended by timeout.";
                } else if (status === "resign") {
                    title = "Resignation";
                    reason = winner
                        ? `${winner === "white" ? "White" : "Black"} won by resignation.`
                        : "A player resigned.";
                } else if (status === "mate") {
                    title = "Checkmate";
                    reason = winner
                        ? `${winner === "white" ? "White" : "Black"} wins by checkmate.`
                        : "Checkmate.";
                } else if (status === "draw") {
                    title = "Draw";
                    reason = "The game ended in a draw.";
                }

                setEndGameTitle(title);
                setEndGameReason(reason);
                setIsGameOverModalOpen(true);
            }
        };

        const handleClock = (
            data: HallGridClock & { gameId: string }
        ) => {
            if (data.gameId !== gameId) return;
            applyClock(data);
        };

        const handleSnapshot = (data: HallGridSession) => {
            applySession(data);
        };

        const handleOpponentPending = (data: HallGridSession) => {
            applySession(data);
        };

        const handleConfirmedMove = (
            data: HallGridSession & {
                sanMove?: string | null;
                lastMove?: {
                    from: string;
                    to: string;
                } | null;
            }
        ) => {
            applySession(data);
        };

        const handleGameOver = (data: HallGridSession) => {
            applySession(data);
        };

        const handleGameError = (data: HallGridSession) => {
            applySession(data);
        };

        const handleRejected = (data: {
            reason?: string;
        }) => {
            setBoardError(
                data.reason || "Physical position rejected."
            );
        };

        const handleSubmissionError = (data: {
            gameId?: string;
            reason?: string;
        }) => {
            if (data.gameId && data.gameId !== gameId) return;

            setBoardError(
                data.reason || "Move submission failed."
            );
        };

        const requestSession = () => {
            socket.emit("get_session");
        };

        socket.on("session_snapshot", handleSnapshot);
        socket.on("clock_update", handleClock);
        socket.on("opponent_move_pending", handleOpponentPending);
        socket.on("game_state_update", handleConfirmedMove);
        socket.on("game_over", handleGameOver);
        socket.on("game_error", handleGameError);
        socket.on("board_update_rejected", handleRejected);
        socket.on("move_submission_error", handleSubmissionError);
        socket.on("connect", requestSession);

        if (socket.connected) {
            requestSession();
        }

        const timer = window.setInterval(renderClock, 100);

        return () => {
            window.clearInterval(timer);

            socket.off("session_snapshot", handleSnapshot);
            socket.off("clock_update", handleClock);
            socket.off(
                "opponent_move_pending",
                handleOpponentPending
            );
            socket.off(
                "game_state_update",
                handleConfirmedMove
            );
            socket.off("game_over", handleGameOver);
            socket.off("game_error", handleGameError);
            socket.off(
                "board_update_rejected",
                handleRejected
            );
            socket.off(
                "move_submission_error",
                handleSubmissionError
            );
            socket.off("connect", requestSession);

            lichessClockRef.current = null;
        };
    }, [socket, mode, gameConfig?.gameId]);


    const getMovePairs = (history: string[]) => {
        const pairs: {
            moveNumber: number;
            white: string;
            black?: string;
        }[] = [];

        for (let i = 0; i < history.length; i += 2) {
            pairs.push({
                moveNumber: Math.floor(i / 2) + 1,
                white: history[i],
                black: history[i + 1],
            });
        }

        return pairs;
    };


    const formatTime = (totalSeconds: number) => {
        const seconds = Math.ceil(Math.max(0, totalSeconds));
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;

        return `${mins}:${String(secs).padStart(2, "0")}`;
    };


    const topPlayerColor =
        boardOrientation === "white" ? "black" : "white";

    const bottomPlayerColor =
        boardOrientation === "white" ? "white" : "black";


    const activeClockColor =
        mode === "lichess"
            ? clockTurn
            : isGameOver
                ? null
                : turn;


    const metadata = session?.metadata;


    const displayedPlayerUsername =
        metadata?.playerUsername ??
        gameConfig?.playerUsername ??
        "You";


    const displayedPlayerRating =
        metadata?.playerRating ??
        gameConfig?.playerRating ??
        "?";


    const displayedOpponentUsername =
        metadata?.opponentUsername ??
        gameConfig?.opponentUsername ??
        "Opponent";


    const displayedOpponentRating =
        metadata?.opponentRating ??
        gameConfig?.opponentRating ??
        "?";


    const botStatusText = isWaitingForPieces
        ? "Place all pieces on the board"
        : isBotThinking
            ? "Bot is thinking…"
            : pendingMove
                ? "Play the highlighted bot move"
                : turn === "white"
                    ? "White's Turn"
                    : "Black's Turn";


    const handleResignLichess = async () => {
        if (
            mode !== "lichess" ||
            !gameConfig?.gameId ||
            isGameOver ||
            isResigning
        ) {
            return;
        }

        const confirmed = window.confirm(
            "Resign this Lichess game? Your opponent will win."
        );

        if (!confirmed) return;

        setIsResigning(true);
        setBoardError(null);

        try {
            const response = await fetch(
                `${backendUrl}/api/lichess/game/${encodeURIComponent(
                    gameConfig.gameId
                )}/resign`,
                {
                    method: "POST",
                }
            );

            const data = await response.json();

            if (!response.ok) {
                throw new Error(
                    data.error || "Could not resign this game."
                );
            }
        } catch (err) {
            setBoardError(
                err instanceof Error
                    ? err.message
                    : "Could not resign this game."
            );

            setIsResigning(false);
        }
    };


    const handleResignLocal = () => {
        if (
            (mode !== "bot" && mode !== "casual") ||
            !gameConfig?.gameId ||
            isGameOver ||
            isResigning
        ) {
            return;
        }

        if (!socket?.connected) {
            setBoardError("Backend connection is not ready.");
            return;
        }

        const message =
            mode === "bot"
                ? "Resign this game? Stockfish will win."
                : `Resign for ${turn === "white" ? "White" : "Black"
                }? The other player will win.`;

        if (!window.confirm(message)) return;

        setIsResigning(true);
        setBoardError(null);

        const event =
            mode === "bot"
                ? "resign_bot_game"
                : "resign_casual_game";

        socket.timeout(10000).emit(
            event,
            { gameId: gameConfig.gameId },
            (
                err: Error | null,
                response?: {
                    status?: string;
                    error?: string;
                }
            ) => {
                setIsResigning(false);

                if (err) {
                    setBoardError(
                        "Resignation confirmation was not received. Checking game state."
                    );

                    socket.emit(
                        mode === "bot"
                            ? "get_bot_session"
                            : "get_casual_session"
                    );
                    return;
                }

                if (response?.error) {
                    setBoardError(response.error);
                }
            }
        );
    };


    return (
        <div
            style={{
                animation: "in .35s ease",
                fontFamily:
                    "500 15px / 1.4 Plus Jakarta Sans, system-ui, sans-serif",
                backgroundColor: "#f3efe6",
                minHeight: "100vh",
                padding: "16px",
            }}
        >
            <div
                style={{
                    maxWidth: "440px",
                    margin: "0 auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                    }}
                >
                    <button
                        onClick={() => setMode("main")}
                        style={{
                            backgroundColor: "#ffffff",
                            border: "none",
                            padding: "8px 16px",
                            borderRadius: "9999px",
                            fontWeight: "600",
                            fontSize: "14px",
                            cursor: "pointer",
                            color: "#1a2f23",
                            boxShadow:
                                "0 1px 3px rgba(0,0,0,0.05)",
                        }}
                    >
                        ← Back
                    </button>

                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                            marginLeft: "auto",
                        }}
                    >
                        <span
                            style={{
                                fontFamily:
                                    "Cinzel, Georgia, serif",
                                fontSize: "17px",
                                fontWeight: "700",
                                color: "#1a2f23",
                            }}
                        >
                            {mode === "bot"
                                ? `vs Stockfish (${gameConfig?.botElo || 1500
                                })`
                                : mode === "casual"
                                    ? "Casual Match"
                                    : "Lichess Match"}
                        </span>
                    </div>
                </div>

                <div
                    style={{
                        backgroundColor: "#ffffff",
                        padding: "10px 16px",
                        borderRadius: "9999px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        boxShadow:
                            "0 2px 6px rgba(0,0,0,0.02)",
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                        }}
                    >
                        <div
                            style={{
                                width: "10px",
                                height: "10px",
                                borderRadius: "50%",
                                backgroundColor:
                                    isWaitingForPieces
                                        ? "#6b7280"
                                        : isBotThinking
                                            ? "#d97706"
                                            : pendingMove
                                                ? "#dc2626"
                                                : "#10b981",
                            }}
                        />

                        <span
                            style={{
                                fontSize: "14px",
                                fontWeight: "600",
                                color: "#1a2f23",
                            }}
                        >
                            {mode === "bot"
                                ? botStatusText
                                : turn === "white"
                                    ? "White's Turn"
                                    : "Black's Turn"}
                        </span>
                    </div>

                    {mode !== "lichess" &&
                        gameConfig?.showEvalBar && (
                            <span
                                style={{
                                    fontSize: "12px",
                                    color: "#1a2f23",
                                    fontWeight: "700",
                                    backgroundColor:
                                        "#b5e7bd",
                                    padding: "4px 12px",
                                    borderRadius: "9999px",
                                }}
                            >
                                Eval: {evalScore}
                            </span>
                        )}
                </div>

                <div
                    style={{
                        backgroundColor: "#ffffff",
                        padding: "10px 16px",
                        borderRadius: "14px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        boxShadow:
                            "0 2px 6px rgba(0,0,0,0.02)",
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                        }}
                    >
                        <div
                            style={{
                                width: "32px",
                                height: "32px",
                                borderRadius: "50%",
                                backgroundColor: "#262421",
                                color: "#fff",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontWeight: "700",
                                fontSize: "12px",
                            }}
                        >
                            {mode === "bot" ? "🤖" : "👤"}
                        </div>

                        <div>
                            <div
                                style={{
                                    fontSize: "14px",
                                    fontWeight: "700",
                                    color: "#1a2f23",
                                }}
                            >
                                {mode === "bot"
                                    ? "Stockfish Bot"
                                    : mode === "lichess"
                                        ? `${displayedOpponentUsername} (${displayedOpponentRating})`
                                        : `Opponent (${topPlayerColor.toUpperCase()})`}
                            </div>
                        </div>
                    </div>

                    {mode !== "bot" && (
                        <div
                            style={{
                                backgroundColor:
                                    activeClockColor ===
                                        topPlayerColor
                                        ? "#1a2f23"
                                        : "#e5e7eb",
                                color:
                                    activeClockColor ===
                                        topPlayerColor
                                        ? "#fff"
                                        : "#374151",
                                padding: "6px 12px",
                                borderRadius: "8px",
                                fontWeight: 700,
                                fontSize: "15px",
                                fontFamily: "monospace",
                            }}
                        >
                            {formatTime(
                                topPlayerColor === "white"
                                    ? whiteTime
                                    : blackTime
                            )}
                        </div>
                    )}
                </div>

                {mode === "lichess" && (
                    <div
                        style={{
                            padding: "12px 16px",
                            borderRadius: "12px",
                            backgroundColor: "#ffffff",
                            color: "#1a2f23",
                        }}
                    >
                        <strong>
                            State: {session?.phase ?? "Loading"}
                        </strong>

                        {session?.pendingOpponentMove && (
                            <p>
                                Play the highlighted opponent move:{" "}
                                <strong>
                                    {
                                        session.pendingOpponentMove
                                            .san
                                    }
                                </strong>{" "}
                                (
                                {
                                    session.pendingOpponentMove
                                        .from
                                }{" "}
                                →{" "}
                                {
                                    session.pendingOpponentMove
                                        .to
                                }
                                )
                            </p>
                        )}

                        {session?.phase === "your_turn" && (
                            <p>
                                Your turn. Make your move and send
                                its resulting FEN.
                            </p>
                        )}

                        {session?.phase ===
                            "validating_move" && (
                                <p>
                                    Waiting for Lichess to confirm
                                    your move…
                                </p>
                            )}

                        {boardError && (
                            <p
                                role="alert"
                                style={{ color: "crimson" }}
                            >
                                {boardError}
                            </p>
                        )}
                    </div>
                )}

                {(mode === "bot" || mode === "casual") && boardError && (
                    <div
                        role="alert"
                        style={{
                            backgroundColor: "#fff1f2",
                            color: "#be123c",
                            border: "1px solid #fecdd3",
                            padding: "12px 16px",
                            borderRadius: "12px",
                            fontSize: "13px",
                            fontWeight: "600",
                        }}
                    >
                        <div>Illegal move.</div>
                        <div style={{ marginTop: "4px" }}>
                            Return the pieces to the previous position.
                        </div>
                        <div style={{ marginTop: "6px", fontWeight: "500" }}>
                            {boardError}
                        </div>
                    </div>
                )}

                <div
                    ref={boardContainerRef}
                    style={{
                        backgroundColor: "#1a2f23",
                        padding: "10px",
                        borderRadius: "20px",
                        display: "flex",
                        justifyContent: "center",
                        alignItems: "center",
                        boxSizing: "border-box",
                        boxShadow:
                            "0 4px 16px rgba(0,0,0,0.08)",
                    }}
                >
                    <div
                        className="brown cburnett"
                        style={{
                            width: `${boardSize}px`,
                            height: `${boardSize}px`,
                            borderRadius: "12px",
                            overflow: "hidden",
                        }}
                    >
                        <Chessground
                            width={boardSize}
                            height={boardSize}
                            config={{
                                fen: fen,
                                coordinates: false,
                                turnColor: turn,
                                orientation: boardOrientation,
                                lastMove: lastMove
                                    ? [
                                        lastMove.from,
                                        lastMove.to,
                                    ]
                                    : [],
                                movable: {
                                    free: false,
                                    color: undefined,
                                    dests: new Map(),
                                },
                                highlight: {
                                    lastMove: true,
                                    check: true,
                                },
                                animation: {
                                    enabled: true,
                                    duration: 200,
                                },
                                drawable: {
                                    enabled: false,
                                    visible: true,
                                    shapes: [],
                                    autoShapes: pendingMove
                                        ? [
                                            {
                                                orig: pendingMove.from,
                                                brush: "green",
                                            },
                                            {
                                                orig: pendingMove.to,
                                                brush: "green",
                                            },
                                            {
                                                orig: pendingMove.from,
                                                dest: pendingMove.to,
                                                brush: "green",
                                            },
                                        ]
                                        : [],
                                },
                                viewOnly: true,
                                draggable: {
                                    enabled: false,
                                },
                                selectable: {
                                    enabled: false,
                                },
                                premovable: {
                                    enabled: false,
                                },
                            }}
                        />
                    </div>
                </div>

                {mode === "lichess" && !isGameOver && (
                    <button
                        type="button"
                        onClick={handleResignLichess}
                        disabled={isResigning || !isConnected}
                        style={{
                            backgroundColor: "#fff1f2",
                            color: "#be123c",
                            border: "1px solid #fecdd3",
                            padding: "11px 16px",
                            borderRadius: "12px",
                            fontWeight: 700,
                            fontSize: "14px",
                            cursor:
                                isResigning || !isConnected
                                    ? "not-allowed"
                                    : "pointer",
                            opacity:
                                isResigning || !isConnected
                                    ? 0.6
                                    : 1,
                        }}
                    >
                        {isResigning
                            ? "Waiting for resignation confirmation…"
                            : "Resign"}
                    </button>
                )}

                {(mode === "bot" || mode === "casual") &&
                    !isGameOver && (
                        <button
                            type="button"
                            onClick={handleResignLocal}
                            disabled={
                                isResigning || !socket?.connected
                            }
                            style={{
                                backgroundColor: "#fff1f2",
                                color: "#be123c",
                                border: "1px solid #fecdd3",
                                padding: "11px 16px",
                                borderRadius: "12px",
                                fontWeight: 700,
                                fontSize: "14px",
                                cursor:
                                    isResigning ||
                                        !socket?.connected
                                        ? "not-allowed"
                                        : "pointer",
                                opacity:
                                    isResigning ||
                                        !socket?.connected
                                        ? 0.6
                                        : 1,
                            }}
                        >
                            {isResigning
                                ? "Resigning…"
                                : mode === "casual"
                                    ? `Resign (${turn === "white"
                                        ? "White"
                                        : "Black"
                                    })`
                                    : "Resign"}
                        </button>
                    )}

                <div
                    style={{
                        backgroundColor: "#ffffff",
                        padding: "10px 16px",
                        borderRadius: "14px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        boxShadow:
                            "0 2px 6px rgba(0,0,0,0.02)",
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                        }}
                    >
                        <div
                            style={{
                                width: "32px",
                                height: "32px",
                                borderRadius: "50%",
                                backgroundColor: "#10b981",
                                color: "#fff",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontWeight: "700",
                                fontSize: "12px",
                            }}
                        >
                            You
                        </div>

                        <div>
                            <div
                                style={{
                                    fontSize: "14px",
                                    fontWeight: "700",
                                    color: "#1a2f23",
                                }}
                            >
                                {mode === "lichess"
                                    ? `${displayedPlayerUsername} (${displayedPlayerRating})`
                                    : `You (${bottomPlayerColor.toUpperCase()})`}
                            </div>
                        </div>
                    </div>

                    {mode !== "bot" && (
                        <div
                            style={{
                                backgroundColor:
                                    activeClockColor ===
                                        bottomPlayerColor
                                        ? "#1a2f23"
                                        : "#e5e7eb",
                                color:
                                    activeClockColor ===
                                        bottomPlayerColor
                                        ? "#fff"
                                        : "#374151",
                                padding: "6px 12px",
                                borderRadius: "8px",
                                fontWeight: 700,
                                fontSize: "15px",
                                fontFamily: "monospace",
                            }}
                        >
                            {formatTime(
                                bottomPlayerColor === "white"
                                    ? whiteTime
                                    : blackTime
                            )}
                        </div>
                    )}
                </div>

                {(mode === "bot" || mode === "casual" || mode === "lichess") &&
    isWaitingForPieces && (
                    <div
                        style={{
                            backgroundColor: "#ffffff",
                            padding: "14px 18px",
                            borderRadius: "18px",
                            textAlign: "center",
                            boxShadow:
                                "0 2px 6px rgba(0,0,0,0.02)",
                        }}
                    >
                        <div
                            style={{
                                fontSize: "15px",
                                fontWeight: "700",
                                color: "#1a2f23",
                            }}
                        >
                            Place all pieces on the board
                        </div>
                    </div>
                )}

                {mode === "bot" && (
                    <div
                        style={{
                            backgroundColor: "#ffffff",
                            padding: "14px 18px",
                            borderRadius: "18px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            boxShadow:
                                "0 2px 6px rgba(0,0,0,0.02)",
                        }}
                    >
                        <div>
                            <div
                                style={{
                                    fontSize: "11px",
                                    textTransform: "uppercase",
                                    letterSpacing: "1px",
                                    color: "#788577",
                                    fontWeight: "700",
                                }}
                            >
                                Bot Move
                            </div>

                            <div
                                style={{
                                    fontSize: "17px",
                                    fontWeight: "700",
                                    color: "#1a2f23",
                                    marginTop: "2px",
                                }}
                            >
                                {suggestedMove}
                            </div>
                        </div>
                    </div>
                )}

                {isGameOverModalOpen && (
                    <div className="fixed inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px] z-50 animate-fadeIn">
                        <div className="bg-[#f7f4eb] p-7 rounded-[2rem] shadow-2xl max-w-sm w-full mx-4 border border-[#1a2f23]/15 text-center relative overflow-hidden">
                            <div className="absolute -top-12 -right-12 w-28 h-28 bg-[#1a2f23]/5 rounded-full pointer-events-none"></div>

                            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-[#1a2f23]/8 flex items-center justify-center text-[#1a2f23] shadow-inner">
                                {game.isCheckmate() ? (
                                    <svg
                                        className="w-7 h-7"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"></path>
                                        <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"></path>
                                        <path d="M4 22h16"></path>
                                        <path d="M10 14.66V17"></path>
                                        <path d="M14 14.66V17"></path>
                                        <path d="M12 2v8"></path>
                                        <path d="M18 2H6l2 10h8l2-10z"></path>
                                    </svg>
                                ) : (
                                    <svg
                                        className="w-7 h-7"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <circle
                                            cx="12"
                                            cy="12"
                                            r="10"
                                        ></circle>
                                        <line
                                            x1="12"
                                            y1="8"
                                            x2="12"
                                            y2="12"
                                        ></line>
                                        <line
                                            x1="12"
                                            y1="16"
                                            x2="12.01"
                                            y2="16"
                                        ></line>
                                    </svg>
                                )}
                            </div>

                            <h2 className="text-2xl font-extrabold text-[#1a2f23] tracking-tight">
                                {endGameTitle}
                            </h2>

                            <p
                                className="text-sm font-medium text-[#1a2f23]/70 mt-1.5 mb-7"
                                style={{ marginBottom: "15px" }}
                            >
                                {endGameReason}
                            </p>

                            <div className="flex flex-col gap-2.5">
                                <button
                                    onClick={async () => {
                                        if (!gameConfig?.gameId)
                                            return;

                                        try {
                                            const gameId =
                                                encodeURIComponent(
                                                    gameConfig.gameId
                                                );

                                            const endpoint =
                                                mode ===
                                                    "lichess"
                                                    ? `${backendUrl}/api/lichess/game/${gameId}/pgn`
                                                    : `${backendUrl}/api/games/${gameId}/pgn`;

                                            const response =
                                                await fetch(
                                                    endpoint
                                                );

                                            if (!response.ok) {
                                                const contentType =
                                                    response.headers.get(
                                                        "content-type"
                                                    ) || "";

                                                let message = `Could not export PGN (${response.status}).`;

                                                if (
                                                    contentType.includes(
                                                        "application/json"
                                                    )
                                                ) {
                                                    const data =
                                                        await response.json();
                                                    message =
                                                        data.error ||
                                                        message;
                                                } else {
                                                    message =
                                                        `The PGN endpoint returned ${response.status}. ` +
                                                        "Check that the Flask route exists and restart the backend.";
                                                }

                                                throw new Error(
                                                    message
                                                );
                                            }

                                            const pgn =
                                                await response.text();

                                            await navigator.clipboard.writeText(
                                                pgn
                                            );

                                            window.open(
                                                "https://lichess.org/paste",
                                                "_blank",
                                                "noopener,noreferrer"
                                            );
                                        } catch (err) {
                                            console.error(err);

                                            setEndGameReason(
                                                err instanceof
                                                    Error
                                                    ? err.message
                                                    : "Could not prepare game analysis."
                                            );
                                        }
                                    }}
                                    disabled={
                                        !gameConfig?.gameId || !fen
                                    }
                                    className="w-full py-3.5 px-4 bg-[#1a2f23] text-white rounded-2xl font-semibold text-sm hover:opacity-95 transition-all shadow-md active:scale-[0.98]"
                                >
                                    Analyze Game
                                </button>

                                <button
                                    onClick={async () => {
                                        if (!gameConfig?.gameId)
                                            return;

                                        try {
                                            const gameId =
                                                encodeURIComponent(
                                                    gameConfig.gameId
                                                );

                                            const endpoint =
                                                mode ===
                                                    "lichess"
                                                    ? `${backendUrl}/api/lichess/game/${gameId}/pgn`
                                                    : `${backendUrl}/api/games/${gameId}/pgn`;

                                            const response =
                                                await fetch(
                                                    endpoint
                                                );

                                            if (!response.ok) {
                                                const contentType =
                                                    response.headers.get(
                                                        "content-type"
                                                    ) || "";

                                                let message = `Could not export PGN (${response.status}).`;

                                                if (
                                                    contentType.includes(
                                                        "application/json"
                                                    )
                                                ) {
                                                    const data =
                                                        await response.json();
                                                    message =
                                                        data.error ||
                                                        message;
                                                } else {
                                                    message =
                                                        `The PGN endpoint returned ${response.status}. ` +
                                                        "Check that the Flask route exists and restart the backend.";
                                                }

                                                throw new Error(
                                                    message
                                                );
                                            }

                                            const pgn =
                                                await response.text();

                                            await navigator.clipboard.writeText(
                                                pgn
                                            );

                                            setCopied(true);
                                            setTimeout(
                                                () =>
                                                    setCopied(
                                                        false
                                                    ),
                                                2000
                                            );
                                        } catch (err) {
                                            console.error(err);

                                            setEndGameReason(
                                                err instanceof
                                                    Error
                                                    ? err.message
                                                    : "Could not copy PGN."
                                            );
                                        }
                                    }}
                                    disabled={
                                        !gameConfig?.gameId
                                    }
                                    className="w-full py-3.5 px-4 bg-[#1a2f23]/8 text-[#1a2f23] rounded-2xl font-semibold text-sm hover:bg-[#1a2f23]/12 transition-all flex items-center justify-center gap-2 active:scale-[0.98]"
                                >
                                    <svg
                                        className="w-4 h-4 opacity-70"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                    >
                                        <rect
                                            x="9"
                                            y="9"
                                            width="13"
                                            height="13"
                                            rx="2"
                                            ry="2"
                                        ></rect>
                                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                    </svg>

                                    {copied
                                        ? "Copied PGN!"
                                        : "Copy PGN"}
                                </button>

                                <button
                                    onClick={() => {
                                        setIsGameOverModalOpen(
                                            false
                                        );
                                        setMode("main");
                                    }}
                                    className="w-full py-3 px-4 text-[#1a2f23]/60 hover:text-[#1a2f23] font-medium text-sm transition-colors mt-1"
                                >
                                    Back to Menu
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                <div
                    style={{
                        backgroundColor: "#ffffff",
                        padding: "12px 16px",
                        borderRadius: "18px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                        boxShadow:
                            "0 2px 6px rgba(0,0,0,0.02)",
                        width: "100%",
                    }}
                >
                    <div
                        style={{
                            fontSize: "12px",
                            fontWeight: "700",
                            textTransform: "uppercase",
                            letterSpacing: "1px",
                            color: "#788577",
                        }}
                    >
                        Move History
                    </div>

                    <div
                        ref={moveHistoryContainerRef}
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "3px",
                            width: "100%",
                            maxHeight: "145px",
                            overflowY: "auto",
                            paddingRight: "4px",
                        }}
                    >
                        {moveHistory.length === 0 ? (
                            <span
                                style={{
                                    fontSize: "12px",
                                    color: "#788577",
                                    fontStyle: "italic",
                                    padding: "4px 0",
                                }}
                            >
                                No moves played yet.
                            </span>
                        ) : (
                            getMovePairs(moveHistory).map(
                                (pair) => (
                                    <div
                                        key={pair.moveNumber}
                                        style={{
                                            display: "flex",
                                            alignItems:
                                                "center",
                                            padding:
                                                "6px 10px",
                                            borderRadius: "6px",
                                            backgroundColor:
                                                pair.moveNumber %
                                                    2 ===
                                                    1
                                                    ? "rgba(243, 239, 230, 0.4)"
                                                    : "rgba(239, 235, 224, 0.8)",
                                            fontSize: "12px",
                                            fontWeight: "600",
                                            fontFamily:
                                                "monospace",
                                            border:
                                                "1px solid rgba(120, 133, 119, 0.15)",
                                            flexShrink: 0,
                                        }}
                                    >
                                        <span
                                            style={{
                                                width: "36px",
                                                color: "#788577",
                                                userSelect:
                                                    "none",
                                            }}
                                        >
                                            {pair.moveNumber}.
                                        </span>

                                        <span
                                            style={{
                                                flex: 1,
                                                color: "#1a2f23",
                                            }}
                                        >
                                            {pair.white}
                                        </span>

                                        <span
                                            style={{
                                                flex: 1,
                                                color: "#1a2f23",
                                            }}
                                        >
                                            {pair.black || ""}
                                        </span>
                                    </div>
                                )
                            )
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}