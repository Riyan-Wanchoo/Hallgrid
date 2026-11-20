"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { Socket } from "socket.io-client";



export interface HallGridClock {
    whiteMs?: number | null;
    blackMs?: number | null;
    whiteIncrementMs?: number | null;
    blackIncrementMs?: number | null;
    runningColor?: "white" | "black" | null;
    receivedAtMs?: number;
    status?: string | null;
}

export interface PendingOpponentMove {
    uci: string;
    from: string;
    to: string;
    promotion: string | null;
    san: string;
}

export interface HallGridMetadata {
    playerUsername?: string | null;
    playerRating?: number | string | null;
    opponentUsername?: string | null;
    opponentRating?: number | string | null;
    rated?: boolean;
    speed?: string;
    variant?: string;
    lichessUrl?: string;

    clockConfig?: {
        initial?: number;
        increment?: number;
    } | null;
}

export interface HallGridSession {
    gameId: string | null;
    phase: string;
    myColor: "white" | "black" | null;
    metadata: HallGridMetadata;

    displayFen: string;
    fen: string;
    serverFen: string;
    initialFen: string;

    physicalReady: boolean;
    pendingOpponentMove: PendingOpponentMove | null;

    status: string | null;
    winner: "white" | "black" | null;
    clock: HallGridClock;
    streamConnected: boolean;
    error: string | null;
}

interface MatchFoundPayload extends HallGridSession {
    // match_found also includes flattened metadata.
    playerUsername?: string | null;
    playerRating?: number | string | null;
    opponentUsername?: string | null;
    opponentRating?: number | string | null;
    rated?: boolean;
}

export interface StartGameConfig {
    color: "white" | "black" | "random";
    botElo: number;
    mode: "bot" | "casual" | "lichess";
    rated: boolean;

    // Keep your frontend configuration in seconds.
    timeLimit: number;
    increment: number;
    showEvalBar: boolean;

    gameId?: string | null;
    playerUsername?: string | null;
    playerRating?: number | string | null;
    opponentUsername?: string | null;
    opponentRating?: number | string | null;

    initialSession?: HallGridSession;
}






interface GameSetupModalProps {
    mode: "bot" | "casual" | "lichess" | "main" | string;
    socket: Socket | null;
    isMatchmaking: boolean;
    onMatchmakingChange: (value: boolean) => void;
    onClose: () => void;
    onStartGame: (config: StartGameConfig) => void;
    onBackToMenu: () => void;
}

export default function GameSetupModal({ mode, socket, isMatchmaking, onMatchmakingChange, onClose, onStartGame, onBackToMenu }: GameSetupModalProps) {


    const [color, setColor] = useState<"white" | "black" | "random">("white");
    const [botElo, setBotElo] = useState<number>(1500);
    const [rated, setRated] = useState<boolean>(false);
    const [timeControl, setTimeControl] = useState<{ limit: number; increment: number }>({
        limit: 300,
        increment: 0,
    }); // Default 5+0
    const [showEvalBar, setShowEvalBar] = useState<boolean>(false);


    const [isSearching, setIsSearching] = useState<boolean>(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);


    const [searchStatus, setSearchStatus] = useState(
        "Matchmaking on Lichess..."
    );
    const searchInFlightRef = useRef(false);
    const startedGameIdRef = useRef<string | null>(null);

    const backendUrl =
    process.env.NEXT_PUBLIC_FLASK_URL ||
    "http://127.0.0.1:5000";

    const clearTransientState = () => {
    searchInFlightRef.current = false;
    startedGameIdRef.current = null;

    setErrorMessage(null);
    setIsSearching(false);
    onMatchmakingChange(false);

    if (socket?.connected) {
        socket.emit("clear_seek_error");
    }
};





    const openLichessGame = useCallback((
        data: HallGridSession & {
            playerUsername?: string | null;
            playerRating?: number | string | null;
            opponentUsername?: string | null;
            opponentRating?: number | string | null;
            rated?: boolean;
        }
    ) => {
        console.log("LICHESS MATCH FOUND:", data);

        if (!data.gameId || !data.myColor) {
            console.error("Invalid Lichess match payload", data);
            return;
        }

        if (startedGameIdRef.current === data.gameId) {
            return;
        }

        startedGameIdRef.current = data.gameId;
        searchInFlightRef.current = false;

        setIsSearching(false);
        onMatchmakingChange(false);
        setErrorMessage(null);

        const metadata = data.metadata;
        const initialMs = metadata?.clockConfig?.initial;
        const incrementMs = metadata?.clockConfig?.increment;

        onStartGame({
            color: data.myColor,
            botElo,
            mode: "lichess",
            rated: data.rated ?? rated,
            timeLimit:
                typeof initialMs === "number"
                    ? initialMs / 1000
                    : timeControl.limit,
            increment:
                typeof incrementMs === "number"
                    ? incrementMs / 1000
                    : timeControl.increment,
            showEvalBar: false,
            gameId: data.gameId,
            playerUsername:
                data.playerUsername ??
                metadata?.playerUsername ??
                null,
            playerRating:
                data.playerRating ??
                metadata?.playerRating ??
                null,
            opponentUsername:
                data.opponentUsername ??
                metadata?.opponentUsername ??
                null,
            opponentRating:
                data.opponentRating ??
                metadata?.opponentRating ??
                null,
            initialSession: data,
        });

        onClose();
    }, [botElo, rated, timeControl.limit, timeControl.increment, onStartGame, onMatchmakingChange, onClose]);

    const handleMatchFound = useCallback((data: any) => {
        openLichessGame(data);
    }, [openLichessGame]);

    const handleMatchFailed = useCallback((data: { reason?: string }) => {
    searchInFlightRef.current = false;
    startedGameIdRef.current = null;

    setIsSearching(false);
    onMatchmakingChange(false);
    setErrorMessage(
        data.reason || "Matchmaking failed. Please try again."
    );
}, [onMatchmakingChange]);




    const sendMatchmakingRequest = async () => {
        if (!socket?.connected || !socket.id) {
            setErrorMessage("Socket connection not ready.");
            return;
        }

        if (searchInFlightRef.current) return;

        searchInFlightRef.current = true;
        startedGameIdRef.current = null;

        setIsSearching(true);
        onMatchmakingChange(true);
        setSearchStatus("Searching for an opponent...");
        setErrorMessage(null);

        try {
            const response = await fetch(
                `${backendUrl}/api/lichess/seek`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        socketId: socket.id,
                        config: {
                            rated,
                            timeLimit: timeControl.limit,
                            timeUnit: "seconds",
                            increment: timeControl.increment,
                            color,
                        },
                    }),
                }
            );

            const result = await response.json();

            if (!response.ok) {
                if (startedGameIdRef.current) return;

                socket?.emit("matchmaking_failed");

                searchInFlightRef.current = false;
                setIsSearching(false);
                onMatchmakingChange(false);
                setErrorMessage(
                    result.error || "Failed to start matchmaking."
                );
                return;
            }

            // 👇 FORCE SOCKET STATE SYNC IMMEDIATELY AFTER SEEK CREATION
            socket.emit("get_session");
        } catch (err) {
            if (startedGameIdRef.current) return;

            socket?.emit("matchmaking_failed");

            searchInFlightRef.current = false;
            setIsSearching(false);
            onMatchmakingChange(false);
            setErrorMessage(
                err instanceof Error
                    ? err.message
                    : "Network error while starting matchmaking."
            );
        }
    };




    const handleGameError = useCallback((data: HallGridSession) => {
        searchInFlightRef.current = false;
        setIsSearching(false);
        onMatchmakingChange(false);
        setErrorMessage(
            data.error || "Could not load the Lichess game."
        );
    }, [onMatchmakingChange]);

    const handleStatus = useCallback((data: HallGridSession) => {
    switch (data.phase) {
        case "searching":
            searchInFlightRef.current = true;
            setIsSearching(true);
            onMatchmakingChange(true);
            setSearchStatus("Searching for an opponent...");
            break;


        case "loading_game":
            searchInFlightRef.current = true;
            setIsSearching(true);
            onMatchmakingChange(true);
            setSearchStatus(
                "Match found. Loading game details..."
            );
            break;


        case "seek_failed":
            searchInFlightRef.current = false;
            startedGameIdRef.current = null;
            setIsSearching(false);
            onMatchmakingChange(false);
            setErrorMessage(
                data.error || "Lichess rejected the search."
            );
            break;


        case "seek_uncertain":
            searchInFlightRef.current = true;
            setIsSearching(true);
            onMatchmakingChange(true);
            setSearchStatus(
                data.error ||
                "Waiting for Lichess confirmation..."
            );
            break;


        case "idle":
            searchInFlightRef.current = false;
            startedGameIdRef.current = null;
            setIsSearching(false);
            onMatchmakingChange(false);
            break;
    }
}, [onMatchmakingChange]);

    useEffect(() => {
        if (!socket) return;

        const handleBotStarted = (data: any) => {
            console.log("BOT GAME STARTED RECEIVED:", data);

            if (startedGameIdRef.current === data.gameId) {
                return;
            }

            startedGameIdRef.current = data.gameId;
            searchInFlightRef.current = false;
            setIsSearching(false);
            onMatchmakingChange(false);
            setErrorMessage(null);

            const resolvedColor: "white" | "black" =
                data.playerColor === "black" ? "black" : "white";

            onStartGame({
                color: resolvedColor,
                botElo: data.botElo ?? botElo,
                mode: "bot",
                rated: false,
                timeLimit: 0,
                increment: 0,
                showEvalBar,
                gameId: data.gameId,
                initialSession: {
                    gameId: data.gameId,
                    phase: data.phase,
                    myColor: resolvedColor,
                    metadata: {},
                    displayFen: data.fen,
                    fen: data.fen,
                    serverFen: data.fen,
                    initialFen: data.initialFen,
                    physicalReady: true,
                    pendingOpponentMove: null,
                    status: data.status,
                    winner: data.winner,
                    clock: {
                        whiteMs: null,
                        blackMs: null,
                        whiteIncrementMs: null,
                        blackIncrementMs: null,
                        runningColor: null,
                        receivedAtMs: Date.now(),
                        status: "started",
                    },
                    streamConnected: true,
                    error: null,
                },
            });

            onClose();
        };

        const handleCasualStarted = (data: any) => {
            console.log("CASUAL GAME STARTED RECEIVED:", data);

            searchInFlightRef.current = false;
            setIsSearching(false);
            setErrorMessage(null);

            onStartGame({
                color: data.playerColor ?? "white",
                botElo,
                mode: "casual",
                rated: false,
                timeLimit: data.timeLimitSeconds ?? timeControl.limit,
                increment: data.incrementSeconds ?? timeControl.increment,
                showEvalBar,
                gameId: data.gameId,
                initialSession: {
                    gameId: data.gameId,
                    phase: data.phase,
                    myColor: data.playerColor ?? "white",
                    metadata: {},
                    displayFen: data.fen,
                    fen: data.fen,
                    serverFen: data.fen,
                    initialFen: data.initialFen,
                    physicalReady: true,
                    pendingOpponentMove: null,
                    status: data.status,
                    winner: data.winner,
                    clock: {
                        whiteMs: data.whiteTimeMs,
                        blackMs: data.blackTimeMs,
                        whiteIncrementMs: data.incrementSeconds * 1000,
                        blackIncrementMs: data.incrementSeconds * 1000,
                        runningColor: "white",
                        receivedAtMs: Date.now(),
                        status: "started",
                    },
                    streamConnected: true,
                    error: null,
                },
            });

            onClose();
        };

        const handleDisconnect = () => {
            if (searchInFlightRef.current) {
                setSearchStatus(
                    "Backend disconnected. Waiting for reconnection..."
                );
            }
        };

        const requestSnapshot = () => {
            socket.emit("get_session");
        };

        socket.on("disconnect", handleDisconnect);
        socket.on("connect", requestSnapshot);
        socket.on("casual_game_started", handleCasualStarted);
        socket.on("bot_game_started", handleBotStarted);
        socket.on("match_found", handleMatchFound);
        socket.on("match_failed", handleMatchFailed);
        socket.on("match_status", handleStatus);
        socket.on("session_snapshot", handleStatus);
        socket.on("game_error", handleGameError);

        return () => {
            socket.off("casual_game_started", handleCasualStarted);
            socket.off("disconnect", handleDisconnect);
            socket.off("connect", requestSnapshot);
            socket.off("bot_game_started", handleBotStarted);
            socket.off("match_found", handleMatchFound);
            socket.off("match_failed", handleMatchFailed);
            socket.off("match_status", handleStatus);
            socket.off("session_snapshot", handleStatus);
            socket.off("game_error", handleGameError);
        };
    }, [
        socket,
        botElo,
        showEvalBar,
        timeControl.limit,
        timeControl.increment,
        onStartGame,
        onClose,
        handleMatchFound,
        handleMatchFailed,
        handleStatus,
        handleGameError,
    ]);





    if (mode == "") return null;



    return (
        <>


            {mode === "bot" && <div style={styles.overlay}>
                <div style={styles.modal}>
                    <h2 style={styles.title}>Configure {mode === "bot" ? "Bot" : mode === "casual" ? "Casual" : "Online"} Match</h2>

                    {/* Color Selection */}
                    <div style={styles.section}>
                        <label style={styles.label}>Play As</label>
                        <div style={styles.buttonGroup}>
                            {(["white", "black", "random"] as const).map((c) => (
                                <button
                                    key={c}
                                    onClick={() => setColor(c)}
                                    style={{
                                        ...styles.colorButton,
                                        ...(color === c ? styles.activeButton : {}),
                                    }}
                                >
                                    {c.charAt(0).toUpperCase() + c.slice(1)}
                                </button>
                            ))}
                        </div>
                    </div>

                    {mode === "bot" && <div style={styles.section}>
                        <div style={styles.sliderHeader}>
                            <label style={styles.label}>Bot ELO Rating</label>
                            <span style={styles.eloBadge}>{botElo}</span>
                        </div>
                        <input
                            type="range"
                            min={800}
                            max={3000}
                            step={100}
                            value={botElo}
                            onChange={(e) => setBotElo(Number(e.target.value))}
                            style={styles.slider}
                        />
                        <div style={styles.sliderLabels}>
                            <span>800 (Beginner)</span>
                            <span>3000 (Grandmaster)</span>
                        </div>
                    </div>}
                    {/* Bot ELO Slider */}



                    {/* Eval Bar Toggle Section */}
                    <div style={styles.section}>
                        <label style={styles.label}>Evaluation Bar</label>
                        <div style={styles.buttonGroup}>
                            <button
                                onClick={() => setShowEvalBar(true)}
                                style={{
                                    ...styles.optionButton,
                                    ...(showEvalBar === true ? styles.activeButton : {}),
                                }}
                            >
                                Show
                            </button>
                            <button
                                onClick={() => setShowEvalBar(false)}
                                style={{
                                    ...styles.optionButton,
                                    ...(showEvalBar === false ? styles.activeButton : {}),
                                }}
                            >
                                Hide
                            </button>
                        </div>
                    </div>


                    {/* Actions */}
                    <div style={styles.actions}>
                        <button onClick={onClose} style={styles.cancelButton}>
                            Cancel
                        </button>
                        <button
                            style={styles.startButton}
                            onClick={() => {
                                console.log("BOT START CLICKED");

                                if (!socket?.connected) {
                                    setErrorMessage("Socket connection not ready.");
                                    return;
                                }

                                startedGameIdRef.current = null;

                                socket.emit(
                                    "start_bot_game",
                                    {
                                        botElo,
                                        color,
                                    },
                                    (response?: {
                                        error?: string;
                                        gameId?: string;
                                        status?: string;
                                    }) => {
                                        console.log("Bot game response:", response);

                                        if (response?.error) {
                                            setErrorMessage(response.error);
                                        }
                                    }
                                );
                            }}
                        >
                            Start Game
                        </button>
                    </div>
                </div>
            </div>}


            {mode === "casual" && <div style={styles.overlay}>
                <div style={styles.modal}>
                    <h2 style={styles.title}>
                        Configure {mode.charAt(0).toUpperCase() + mode.slice(1)} Match
                    </h2>

                    {/* Time Control Section */}
                    <div style={styles.section}>
                        <label style={styles.label}>Time Control</label>
                        <div style={styles.buttonGroup}>
                            {[
                                { label: "3 + 0", limit: 180, inc: 0 },
                                { label: "5 + 0", limit: 300, inc: 0 },
                                { label: "10 + 0", limit: 600, inc: 0 },
                            ].map((tc) => (
                                <button
                                    key={tc.label}
                                    onClick={() => {
                                        clearTransientState();
                                        setTimeControl({ limit: tc.limit, increment: tc.inc });
                                    }}

                                    style={{
                                        ...styles.optionButton,
                                        ...(timeControl.limit === tc.limit ? styles.activeButton : {}),
                                    }}
                                >
                                    {tc.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Play As Section */}
                    <div style={styles.section}>
                        <label style={styles.label}>Play As</label>
                        <div style={styles.buttonGroup}>
                            {(["white", "black", "random"] as const).map((c) => (
                                <button
                                    key={c}
                                    onClick={() => {
                                        clearTransientState();
                                        setColor(c);
                                    }}
                                    style={{
                                        ...styles.optionButton,
                                        ...(color === c ? styles.activeButton : {}),
                                    }}
                                >
                                    {c.charAt(0).toUpperCase() + c.slice(1)}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Eval Bar Toggle Section */}
                    <div style={styles.section}>
                        <label style={styles.label}>Evaluation Bar</label>
                        <div style={styles.buttonGroup}>
                            <button
                                onClick={() => setShowEvalBar(true)}
                                style={{
                                    ...styles.optionButton,
                                    ...(showEvalBar === true ? styles.activeButton : {}),
                                }}
                            >
                                Show
                            </button>
                            <button
                                onClick={() => setShowEvalBar(false)}
                                style={{
                                    ...styles.optionButton,
                                    ...(showEvalBar === false ? styles.activeButton : {}),
                                }}
                            >
                                Hide
                            </button>
                        </div>
                    </div>

                    {/* Action Buttons */}
                    <div style={styles.actions}>
                        <button onClick={onClose} style={styles.cancelButton}>
                            Cancel
                        </button>
                        <button
                            onClick={() => {



                                if (searchInFlightRef.current) {
                                    return;
                                }

                                searchInFlightRef.current = true;
                                console.log("CASUAL START CLICKED");
                                console.log("Socket connected:", socket?.connected);
                                console.log("Socket ID:", socket?.id);

                                if (!socket?.connected) {
                                    console.log("Socket is not connected");
                                    setErrorMessage("Socket connection not ready.");
                                    return;
                                }

                                console.log("Emitting start_casual_game");

                                socket.emit(
                                    "start_casual_game",
                                    {
                                        timeLimit: timeControl.limit,
                                        increment: timeControl.increment,
                                        color,
                                    },
                                    (response?: {
                                        error?: string;
                                        gameId?: string;
                                        status?: string;
                                    }) => {
                                        console.log("Casual game response:", response);

                                        if (response?.error) {
                                            setErrorMessage(response.error);
                                            return;
                                        }

                                        // Fallback only. Normally, `casual_game_started`
                                        // starts the game with the full backend snapshot.
                                        if (
                                            response?.status === "ok" &&
                                            response.gameId &&
                                            !startedGameIdRef.current
                                        ) {
                                            startedGameIdRef.current = response.gameId;
                                            searchInFlightRef.current = false;

                                            onStartGame({
                                                color,
                                                botElo,
                                                mode: "casual",
                                                rated: false,
                                                timeLimit: timeControl.limit,
                                                increment: timeControl.increment,
                                                showEvalBar,
                                                gameId: response.gameId,
                                                initialSession: {
                                                    gameId: response.gameId,
                                                    phase: "your_turn",
                                                    myColor: color === "random" ? "white" : color,
                                                    metadata: {},
                                                    displayFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                                                    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                                                    serverFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                                                    initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                                                    physicalReady: true,
                                                    pendingOpponentMove: null,
                                                    status: "started",
                                                    winner: null,
                                                    clock: {
                                                        whiteMs: timeControl.limit * 1000,
                                                        blackMs: timeControl.limit * 1000,
                                                        whiteIncrementMs:
                                                            timeControl.increment * 1000,
                                                        blackIncrementMs:
                                                            timeControl.increment * 1000,
                                                        runningColor: "white",
                                                        receivedAtMs: Date.now(),
                                                        status: "started",
                                                    },
                                                    streamConnected: true,
                                                    error: null,
                                                },
                                            });

                                            onClose();
                                        }
                                    }
                                );
                            }}
                            style={styles.startButton}
                        >
                            Start Game
                        </button>
                    </div>
                </div>
            </div>}

            {mode === "lichess" && <div style={styles.overlay}>
                <div style={styles.modal}>
                    <h2 style={styles.title}>
                        Configure {rated ? "Rated" : "Casual"} Online Match
                    </h2>
                    <div style={styles.section}>
                        <label style={styles.label}>Match Type</label>
                        <div style={styles.buttonGroup}>
                            <button
                                onClick={() => {
                                    clearTransientState();
                                    setRated(false);
                                }}
                                style={{
                                    ...styles.optionButton,
                                    ...(rated === false ? styles.activeButton : {}),
                                }}
                            >
                                Casual (Unrated)
                            </button>
                            <button
                                onClick={() => {
                                    clearTransientState();
                                    setRated(true);
                                }}
                                style={{
                                    ...styles.optionButton,
                                    ...(rated === true ? styles.activeButton : {}),
                                }}
                            >
                                Rated
                            </button>
                        </div>
                    </div>
                    <div style={styles.section}>
                        <label style={styles.label}>Time Control</label>
                        {rated ? <div style={styles.buttonGroup}>
                            {[
                                { label: "10 + 0", limit: 600, inc: 0 },
                                { label: "15 + 10", limit: 900, inc: 10 },
                                { label: "30 + 0", limit: 1800, inc: 0 },
                            ].map((tc) => (
                                <button
                                    key={tc.label}
                                    onClick={() => {
                                        clearTransientState();
                                        setTimeControl({ limit: tc.limit, increment: tc.inc });
                                    }}
                                    style={{
                                        ...styles.optionButton,
                                        ...(timeControl.limit === tc.limit &&
                                            timeControl.increment === tc.inc
                                            ? styles.activeButton
                                            : {}),
                                    }}
                                >
                                    {tc.label}
                                </button>
                            ))}
                        </div> : <div style={styles.buttonGroup}>
                            {[
                                { label: "10 + 0", limit: 600, inc: 0 },
                                { label: "15 + 10", limit: 900, inc: 10 },
                                { label: "30 + 0", limit: 1800, inc: 0 },
                            ].map((tc) => (
                                <button
                                    key={tc.label}
                                    onClick={() => {
                                        clearTransientState();
                                        setTimeControl({ limit: tc.limit, increment: tc.inc });
                                    }}
                                    style={{
                                        ...styles.optionButton,
                                        ...(timeControl.limit === tc.limit &&
                                            timeControl.increment === tc.inc
                                            ? styles.activeButton
                                            : {}),
                                    }}
                                >
                                    {tc.label}
                                </button>
                            ))}
                        </div>}

                    </div>

                    {/* Play As Section */}
                    <div style={styles.section}>
                        <label style={styles.label}>Play As</label>
                        <div style={styles.buttonGroup}>
                            {(["white", "black", "random"] as const).map((c) => (
                                <button
                                    key={c}
                                    onClick={() => {
                                        clearTransientState();
                                        setColor(c);
                                    }}
                                    style={{
                                        ...styles.optionButton,
                                        ...(color === c ? styles.activeButton : {}),
                                    }}
                                >
                                    {c.charAt(0).toUpperCase() + c.slice(1)}
                                </button>
                            ))}
                        </div>
                    </div>





                    {isSearching && (
                        <div className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm z-[1100]">
                            <div className="bg-[#f7f4eb] p-8 rounded-[2rem] shadow-2xl max-w-sm w-full mx-4 border border-[#1a2f23]/15 text-center">
                                <div className="w-14 h-14 mx-auto mb-5 rounded-full border-4 border-[#1a2f23]/15 border-t-[#1a2f23] animate-spin" />

                                <h2 className="text-2xl font-extrabold text-[#1a2f23] tracking-tight">
                                    Finding an opponent
                                </h2>

                                <p className="text-sm font-medium text-[#1a2f23]/70 mt-2">
                                    {searchStatus}
                                </p>

                                <p className="text-xs text-[#1a2f23]/50 mt-4">
                                    {timeControl.limit / 60}+{timeControl.increment} ·{" "}
                                    {rated ? "Rated" : "Casual"}
                                </p>
                            </div>
                        </div>
                    )}
                    {errorMessage && (
                        <div className="fixed inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px] z-50 animate-fadeIn">
                            <div className="bg-[#f7f4eb] p-7 rounded-[2rem] shadow-2xl max-w-sm w-full mx-4 border border-[#1a2f23]/15 text-center relative overflow-hidden">

                                {/* Decorative subtle background aura */}
                                <div className="absolute -top-12 -right-12 w-28 h-28 bg-[#1a2f23]/5 rounded-full pointer-events-none"></div>

                                {/* Title & Reason */}
                                <h2 className="text-2xl font-extrabold text-[#1a2f23] tracking-tight">
                                    Error: {errorMessage}
                                </h2>
                                <button
    onClick={() => {
        searchInFlightRef.current = false;
        startedGameIdRef.current = null;

        setIsSearching(false);
        onMatchmakingChange(false);
        setErrorMessage(null);

        if (socket?.connected) {
            socket.emit("cancel_matchmaking");
            socket.emit("clear_seek_error");
        }

        onBackToMenu();
    }}
    style={styles.cancelButton2}
>
    Back
</button>
                            </div>
                        </div>
                    )}





                    {/* Action Buttons */}
                    <div style={styles.actions}>
                        <button onClick={onClose} style={styles.cancelButton}>
                            Cancel
                        </button>
                        <button
                            onClick={sendMatchmakingRequest}
                            disabled={isSearching || !socket?.connected}
                            style={{
                                ...styles.startButton,
                                opacity: isSearching || !socket?.connected ? 0.6 : 1,
                                cursor:
                                    isSearching || !socket?.connected
                                        ? "not-allowed"
                                        : "pointer",
                            }}
                        >
                            {isSearching ? "Searching..." : "Start Match"}
                        </button>
                    </div>
                </div>
            </div>}

        </>

    );
}

// Styles tailored for your HallGrid professional aesthetic
const styles = {
    overlay: {
        position: "fixed" as const,
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        backdropFilter: "blur(4px)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 1000,
    },
    modal: {
        backgroundColor: "#F4F0E6",
        padding: "25px",
        borderRadius: "16px",
        width: "90%",
        boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
        display: "flex",
        flexDirection: "column" as const,
        gap: "24px",
        color: "#1a2f23",
    },
    title: {
        margin: 0,
        fontSize: "22px",
        fontWeight: 700,
        textAlign: "center" as const,
    },
    section: {
        display: "flex",
        flexDirection: "column" as const,
        gap: "8px",
    },
    label: {
        fontSize: "14px",
        fontWeight: 600,
        color: "#4a5568",
    },
    buttonGroup: {
        display: "flex",
        gap: "8px",
    },
    colorButton: {
        flex: 1,
        padding: "10px",
        borderRadius: "8px",
        // ❌ DO NOT USE: border: "1px solid #cbd5e1"
        // ✅ USE INDIVIDUAL LONGHAND PROPERTIES INSTEAD:
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "#cbd5e1",
        backgroundColor: "#f8fafc",
        cursor: "pointer",
        fontWeight: 600,
        color: "#334155",
        transition: "all 0.2s",
    },
    activeButton: {
        backgroundColor: "#1a2f23",
        color: "#ffffff",
        borderColor: "#1a2f23", // Now safely updates without shorthand conflicts!
    },
    sliderHeader: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
    },
    eloBadge: {
        backgroundColor: "#e2e8f0",
        padding: "2px 8px",
        borderRadius: "6px",
        fontWeight: 700,
        fontSize: "14px",
        color: "#1a2f23",
    },
    optionButton: {
        flex: 1,
        padding: "10px",
        borderRadius: "10px",
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "#cbd5e1",
        backgroundColor: "#ffffff",
        cursor: "pointer",
        fontWeight: 600,
        fontSize: "14px",
        color: "#334155",
        transition: "all 0.2s ease",
    },
    slider: {
        width: "100%",
        cursor: "pointer",
        accentColor: "#1a2f23",
    },
    sliderLabels: {
        display: "flex",
        justifyContent: "space-between",
        fontSize: "12px",
        color: "#64748b",
    },
    actions: {
        display: "flex",
        gap: "12px",
        marginTop: "8px",
    },
    cancelButton: {
        flex: 1,
        padding: "12px",
        borderRadius: "8px",
        border: "1px solid #cbd5e1",
        backgroundColor: "#ffffff",
        cursor: "pointer",
        fontWeight: 600,
        color: "#64748b",
    },
    cancelButton2: {
        flex: 1,
        padding: "12px",
        borderRadius: "8px",
        border: "1px solid #cbd5e1",
        backgroundColor: "#ffffff",
        cursor: "pointer",
        fontWeight: 600,
        color: "#64748b",
        marginTop: "10px"
    },
    startButton: {
        flex: 1,
        padding: "12px",
        borderRadius: "8px",
        border: "none",
        backgroundColor: "#1a2f23",
        cursor: "pointer",
        fontWeight: 600,
        color: "#ffffff",
    },
};