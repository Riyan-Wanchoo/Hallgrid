"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { Socket } from "socket.io-client";

import GameSetupModal, {
    type StartGameConfig,
} from "@/components/GameSetupModal";



// Import essential Lichess Chessground stylesheets
import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";
import PlayScreen from "./PlayScreen";

export type PlayMode = "main" | "bot" | "casual" | "lichess";



interface PlayScreenProps {
    socket: Socket | null;
    setActiveScreen: (screen: "home" | "play") => void;
    isConnected: boolean;
}



interface SavedGame {
    gameId: string;
    mode: "bot" | "casual" | "lichess";
    playerColor: "white" | "black" | null;
    botElo: number | null;
    opponentUsername?: string | null;
    status: string | null;
    winner: "white" | "black" | null;
    createdAt: string;
    updatedAt: string;
}


export default function Play({ socket, setActiveScreen, isConnected }: PlayScreenProps) {


    const backendUrl =
        process.env.NEXT_PUBLIC_FLASK_URL ||
        "http://127.0.0.1:5000";

    const [savedGames, setSavedGames] = useState<SavedGame[]>([]);
    const [historyPage, setHistoryPage] = useState(1);
    const [historyHasMore, setHistoryHasMore] = useState(true);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);

    const [openedGameId, setOpenedGameId] = useState<string | null>(null);


    useEffect(() => {
        if (!openedGameId) return;

        const timer = window.setTimeout(() => {
            setOpenedGameId(null);
        }, 3000);

        return () => window.clearTimeout(timer);
    }, [openedGameId]);



    const historySentinelRef = useRef<HTMLDivElement | null>(null);
    const historyLoadingRef = useRef(false);


    const loadSavedGames = useCallback(
        async (page: number) => {
            if (historyLoadingRef.current) return;


            historyLoadingRef.current = true;
            setHistoryLoading(true);
            setHistoryError(null);


            try {
                const response = await fetch(
                    `${backendUrl}/api/games?page=${page}&limit=20`
                );


                const data = await response.json();


                if (!response.ok) {
                    throw new Error(
                        data.error || "Could not load match history."
                    );
                }


                setSavedGames((previous) =>
                    page === 1
                        ? data.games
                        : [...previous, ...data.games]
                );


                setHistoryHasMore(data.hasMore);
                setHistoryPage(page);
            } catch (err) {
                setHistoryError(
                    err instanceof Error
                        ? err.message
                        : "Could not load match history."
                );
            } finally {
                historyLoadingRef.current = false;
                setHistoryLoading(false);
            }
        },
        [backendUrl]
    );



    const openSavedGame = useCallback(
        async (game: SavedGame) => {
            try {
                const endpoint =
                    game.mode === "lichess"
                        ? `${backendUrl}/api/lichess/game/${game.gameId}/pgn`
                        : `${backendUrl}/api/games/${game.gameId}/pgn`;


                const response = await fetch(endpoint);


                if (!response.ok) {
                    const data = await response.json();
                    throw new Error(
                        data.error || "Could not export this game's PGN."
                    );
                }


                const pgn = await response.text();


                await navigator.clipboard.writeText(pgn);

                setOpenedGameId(game.gameId);


                window.open(
                    "https://lichess.org/paste",
                    "_blank",
                    "noopener,noreferrer"
                );
            } catch (err) {
                setHistoryError(
                    err instanceof Error
                        ? err.message
                        : "Could not open this game for analysis."
                );
            }
        },
        [backendUrl]
    );



    const [mode, setMode] = useState<PlayMode>("main");
    const [ModalMode, setIsModalOpen] = useState("");
    const [BoardConnectionModalDisplay, setBoardConnectionModalDisplay] = useState(false)

    const [isMatchmaking, setIsMatchmaking] = useState(false);





    const [gameConfig, setGameConfig] = useState<StartGameConfig>({
        color: "white",
        botElo: 1500,
        mode: "bot",
        rated: false,
        timeLimit: 300,
        increment: 0,
        showEvalBar: true,
        gameId: null,
        playerUsername: null,
        playerRating: null,
        opponentUsername: null,
        opponentRating: null,
        initialSession: undefined,
    });



    const handleStartGame = useCallback((config: StartGameConfig) => {
        setGameConfig(config);
        console.log(config.mode)
        setMode(config.mode);
        setIsModalOpen("");
    }, []);

    const handleCloseSetup = useCallback(() => {
        setIsModalOpen("");
    }, []);


    const handlePlayClick = async (selectedMode: PlayMode) => {
        if (!isConnected) {
            setBoardConnectionModalDisplay(true);
            return;
        }


        setIsModalOpen(selectedMode);
    };


    useEffect(() => {
        if (mode === "main") {
            loadSavedGames(1);
        }
    }, [mode, loadSavedGames]);


    useEffect(() => {
        const sentinel = historySentinelRef.current;


        if (!sentinel) return;


        const observer = new IntersectionObserver(
            (entries) => {
                if (
                    entries[0].isIntersecting &&
                    historyHasMore &&
                    !historyLoading
                ) {
                    loadSavedGames(historyPage + 1);
                }
            },
            {
                rootMargin: "200px",
            }
        );


        observer.observe(sentinel);


        return () => {
            observer.disconnect();
        };
    }, [historyHasMore, historyLoading, historyPage, loadSavedGames]);

    const getHistoryResult = (game: SavedGame): string => {
        if (!game.status || ["created", "started"].includes(game.status)) {
            return "Result unavailable";
        }

        if (["aborted", "noStart"].includes(game.status)) {
            return "Game aborted";
        }

        if (!game.winner) {
            return "Draw";
        }

        // Older records may not have your color saved.
        if (!game.playerColor) {
            return `${game.winner === "white" ? "White" : "Black"} won`;
        }

        if (game.winner === game.playerColor) {
            return "You won";
        }

        if (game.mode === "bot") {
            return "Stockfish won";
        }

        if (game.mode === "lichess") {
            return `${game.opponentUsername || "Opponent"} won`;
        }

        return "Opponent won";
    };


    return (
        <>
            {mode == "main" && <><section id="play" className="scr on">
                <h1 className="hd">Play</h1>
                <p className="mut">Choose how you want to play</p>
                <div className="list">
                    <button className="card" onClick={() => handlePlayClick("bot")}><i className="ic" data-i="bot"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h8a3 3 0 013 3v4a3 3 0 01-3 3H8a3 3 0 01-3-3v-4a3 3 0 013-3zM12 4v4M9.5 13h.01M14.5 13h.01"></path></svg></i><span style={{ flex: 1 }}><b>Play
                        against bot</b><span className="mut">Practice at your own level</span></span><i data-i="chev"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></i></button>
                    <button className="card" onClick={() => handlePlayClick("casual")}><i className="ic" data-i="smile"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 100 16 8 8 0 000-16zM8.5 14c1 1.5 2.2 2 3.5 2s2.5-.5 3.5-2M9 10h.01M15 10h.01"></path></svg></i><span style={{ flex: 1 }}><b>Play casual</b><span className="mut">Pass and play on this
                        device</span></span><i data-i="chev"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></i></button>
                    <button className="card" onClick={() => handlePlayClick("lichess")}><i className="ic" data-i="globe"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 100 16 8 8 0 000-16zM4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16"></path></svg></i><span style={{ flex: 1 }}><b>Play online</b><span className="mut">Find an opponent (demo
                        opponent)</span></span><i data-i="chev"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></i></button>
                </div>

            </section>
                <div className="containerx">
                    <div className="sec">
                        <h2 className="hd" style={{ fontSize: "19px" }}>Match History</h2>
                    </div>


                    {historyError && (
                        <div className="card" style={{ color: "#991b1b" }}>
                            {historyError}
                        </div>
                    )}


                    {!historyLoading && savedGames.length === 0 && !historyError && (
                        <div className="card" style={{ justifyContent: "center", color: "#788577" }}>
                            No completed games saved yet.
                        </div>
                    )}



                    {savedGames.length > 0 && (
                        <div
                            className="card"
                            style={{
                                flexDirection: "column",
                                alignItems: "stretch",
                                gap: 0,
                                padding: "4px 14px",
                            }}
                        >
                            {savedGames.map((game) => (
                                <button
                                    key={game.gameId}
                                    className="lm"
                                    onClick={() => openSavedGame(game)}
                                >
                                    <span className="av">
                                        {game.mode === "bot"
                                            ? "B"
                                            : game.mode === "casual"
                                                ? "C"
                                                : "L"}
                                    </span>

                                    <span style={{ flex: 1 }}>
                                        <b>
                                            {game.mode === "bot"
                                                ? `Stockfish (${game.botElo ?? "?"})`
                                                : game.mode === "casual"
                                                    ? "Casual Game"
                                                    : "Lichess Game"}
                                        </b>

                                        <span className="mut">
                                            {getHistoryResult(game)}
                                        </span>

                                        {openedGameId === game.gameId && (
                                            <span className="mut">
                                                PGN copied. Paste it on Lichess to analyse.
                                            </span>
                                        )}
                                    </span>

                                    <span className="chip">
                                        {new Date(game.updatedAt).toLocaleDateString()}
                                    </span>
                                </button>
                            ))}

                            <div
                                ref={historySentinelRef}
                                style={{ height: "1px" }}
                            />
                        </div>
                    )}


                    {historyLoading && (
                        <div
                            className="card"
                            style={{ justifyContent: "center", color: "#788577" }}
                        >
                            Loading games…
                        </div>
                    )}


                </div>
            </>
            }


            <GameSetupModal
                mode={ModalMode}
                socket={socket}
                isMatchmaking={isMatchmaking}
                onMatchmakingChange={setIsMatchmaking}
                onClose={() => setIsModalOpen("")}
                onStartGame={handleStartGame}
                onBackToMenu={() => setMode("main")}
            />


            {BoardConnectionModalDisplay && (
                <div className="fixed inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px] z-50 animate-fadeIn">
                    <div className="bg-[#f7f4eb] p-7 rounded-[2rem] shadow-2xl max-w-sm w-full mx-4 border border-[#1a2f23]/15 text-center relative overflow-hidden" style={{ animation: ".35s i" }}>


                        {/* Title & Subtitle */}
                        <h2 className="text-2xl font-extrabold text-[#1a2f23] tracking-tight" style={{ margin: "12px 0px" }}>
                            Board Disconnected
                        </h2>
                        <p className="text-sm font-medium text-[#1a2f23]/70 mt-1.5 mb-7 leading-relaxed">
                            Lost connection to your smart chessboard via Serial/Socket. Please check your USB or Wi-Fi connection.
                        </p>

                        {/* Action Buttons */}
                        <div className="flex flex-col gap-2.5" style={{ marginTop: "10px" }}>

                            {/* Try Reconnecting (Primary) */}
                            <button
                                onClick={() => {
                                    setBoardConnectionModalDisplay(false);
                                    setMode("main");
                                }}
                                className="w-full py-3.5 px-4 bg-[#1a2f23] text-white rounded-2xl font-semibold text-sm hover:opacity-95 transition-all shadow-md active:scale-[0.98] flex items-center justify-center gap-2"
                            >
                                Back to Menu
                            </button>
                        </div>
                    </div>
                </div>
            )}


            {mode === "bot" && (<PlayScreen socket={socket} mode="bot" setMode={setMode} isConnected={isConnected} gameConfig={gameConfig} />)}


            {mode === "casual" && <PlayScreen socket={socket} mode="casual" setMode={setMode} isConnected={isConnected} gameConfig={gameConfig} />}


            {mode === "lichess" && gameConfig.gameId && (
                <PlayScreen
                    key={gameConfig.gameId}
                    socket={socket}
                    mode="lichess"
                    setMode={setMode}
                    isConnected={isConnected}
                    gameConfig={gameConfig}
                />
            )}
        </>


    )
}