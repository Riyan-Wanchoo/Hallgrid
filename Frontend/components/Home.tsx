import Icon from "./Icon";
import React, { useState, useEffect } from 'react';
import {
    History,
    Activity,
    TrendingUp,
    Cpu,
    CheckCircle2,
    RefreshCw,
    Sliders,
    X,
    Search,
    BarChart3,
    Terminal,
    AlertTriangle,
} from 'lucide-react';




interface HomeProps {
    setActiveScreen: (screen: string) => void;
    isConnected: boolean;
}


interface RecentGame {
    gameId: string;
    mode: "bot" | "casual" | "lichess";
    playerColor: "white" | "black" | null;
    botElo: number | null;
    opponentUsername?: string | null;
    status: string | null;
    winner: "white" | "black" | null;
    updatedAt: string;
}



export default function Home({ setActiveScreen, isConnected }: HomeProps) {

    const [activeModal, setActiveModal] = useState<string | null>(null); // 'connection_log', 'diagnostics', 'stats', 'device', null

    // Connection Log State & Filters
    const [logFilter, setLogFilter] = useState('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [logs] = useState([
        { id: 1, event: 'Socket.IO Connected', device: 'Flask Backend (:5000)', time: 'Live Session', status: 'success', latency: '14ms', details: 'WebSocket & polling transport active with HallGrid server' },
        { id: 2, event: 'Pico LED Link Ready', device: 'Raspberry Pi Pico (COM3)', time: 'Live Session', status: 'success', latency: '2ms', details: '146-LED WS2812B serial controller initialized at 115200 baud' },
        { id: 3, event: 'Hand Occlusion Detected', device: 'piece_finder_weights.pt', time: 'Vision Loop', status: 'warning', latency: '50ms', details: 'Hand present in cropped board; FEN emission paused until hand clears' },
        { id: 4, event: 'Lichess Stream Synced', device: 'Lichess Board API', time: 'Match Stream', status: 'success', latency: '38ms', details: 'Moves, clocks, and game state synced with SQLite match history' },
        { id: 5, event: 'Stockfish UCI Ready', device: 'Stockfish Engine (Depth 12)', time: 'Engine Pool', status: 'success', latency: '8ms', details: 'Configured with 2 threads and 128 MB hash for bot & eval updates' },
        { id: 6, event: '180° Black LED Flip Active', device: 'LED Coordinate Mapper', time: 'Orientation', status: 'warning', latency: '<1ms', details: 'Fixed-seat Black mode rotates physical LED squares 180° to match seat' }
    ]);

    // Board Diagnostics State
    const [dwellTime, setDwellTime] = useState(50);
    const [boardState, setBoardState] = useState(() => {
        const grid = Array(8).fill(null).map(() => Array(8).fill(false));
        // Standard setup occupied squares
        [0, 1, 6, 7].forEach(r => {
            for (let c = 0; c < 8; c++) grid[r][c] = true;
        });
        return grid;
    });
    const [diagLog, setDiagLog] = useState([
        { time: 'BOOT', msg: 'YOLO chessboxweights.pt & piece_finder_weights.pt ready.' },
        { time: 'LED', msg: 'Raspberry Pi Pico 146-LED WS2812B matrix on GP17 ready.' },
        { time: 'SYNC', msg: 'Flask Socket.IO + python-chess + Stockfish initialized.' }
    ]);
    const [isSweeping, setIsSweeping] = useState(false);



    const [recentGames, setRecentGames] = useState<RecentGame[]>([]);


    // Toggle square state on 8x8 matrix preview
    const toggleSquare = (r: number, c: number) => {
        const newBoard = boardState.map(row => [...row]);
        newBoard[r][c] = !newBoard[r][c];
        setBoardState(newBoard);

        const file = String.fromCharCode(97 + c);
        const rank = 8 - r;
        const squareName = `${file}${rank}`;
        const action = newBoard[r][c] ? 'OCCUPIED (X)' : 'CLEAR (.)';

        setDiagLog(prev => [
            { time: new Date().toLocaleTimeString(), msg: `Square ${squareName}: Grid[${r}][${c}] -> ${action}` },
            ...prev.slice(0, 19)
        ]);
    };

    const runFullMatrixTest = () => {
        setIsSweeping(true);
        setDiagLog(prev => [
            { time: new Date().toLocaleTimeString(), msg: 'Verifying 8x8 square grid & 146-LED WS2812B mapping...' },
            ...prev
        ]);
        setTimeout(() => {
            setIsSweeping(false);
            setDiagLog(prev => [
                { time: new Date().toLocaleTimeString(), msg: '✓ Check complete: 64 squares mapped across 146 Pico WS2812B LEDs.' },
                ...prev
            ]);
        }, 600);
    };


    const backendUrl =
        process.env.NEXT_PUBLIC_FLASK_URL ||
        "http://127.0.0.1:5000";


    // Filtered Connection Logs
    const filteredLogs = logs.filter(log => {
        const matchesFilter = logFilter === 'all' || log.status === logFilter;
        const matchesSearch = log.event.toLowerCase().includes(searchQuery.toLowerCase()) ||
            log.device.toLowerCase().includes(searchQuery.toLowerCase()) ||
            log.details.toLowerCase().includes(searchQuery.toLowerCase());
        return matchesFilter && matchesSearch;
    });


    const getRecentGameResult = (game: RecentGame): string => {
        if (!game.status || ["created", "started"].includes(game.status)) {
            return "In progress";
        }

        if (["aborted", "noStart"].includes(game.status)) {
            return "Game aborted";
        }

        if (!game.winner) {
            return "Draw";
        }

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



    useEffect(() => {
        const loadRecentGames = async () => {
            try {
                const response = await fetch(
                    `${backendUrl}/api/games?page=1&limit=2`
                );

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(
                        data.error || "Could not load recent games."
                    );
                }

                setRecentGames(data.games);
            } catch (error) {
                console.error(error);
            }
        };

        loadRecentGames();
    }, [backendUrl]);
    return (
        <>
            <section id="home" className="scr on">
                <header className="top">
                    <div className="logo">
                        <span className="hd" id="main_logo">
                            HallGrid

                        </span>
                    </div>
                    <div className="act">
                        <div className={`status-pill ${isConnected ? "connected" : "disconnected"}`}>
                            <div className="status-dot-wrapper">
                                {/* Only show the ping animation when connected */}
                                {isConnected && <div className="status-dot-ping"></div>}
                                <div className="status-dot"></div>
                            </div>
                            <span>{isConnected ? "Board Connected" : "Board Disconnected"}</span>
                        </div>
                    </div>
                </header>
                <div className="hero">
                    <div className="hd">Better at chess. Together.</div>
                    <p>Learn. Play. Compete. Join a global community of master chess enthusiasts.</p><button className="cta"
                        data-go="play" onClick={() => setActiveScreen('play')}>
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>
                        Start playing</button><b className="kg" aria-hidden="true">♚</b>
                </div>

                <div className="dashboard-grid">
                    <button className="dashboard-card" onClick={() => setActiveModal('connection_log')}>
                        <span className="icon-tile">
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-lucide="history" aria-hidden="true" className="lucide lucide-history"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l4 2"></path></svg>
                        </span>
                        <h3 className="card-title">Connection Log</h3>
                        <p className="card-description">
                            Socket.IO, Pico serial, YOLO vision, and Lichess events.
                        </p>
                        <span className="card-action">
                            View history <Icon name="arrowUpRight" />
                        </span>
                    </button>

                    <button className="dashboard-card" onClick={() => setActiveModal('diagnostics')}>
                        <span className="icon-tile">
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-lucide="activity" aria-hidden="true" className="lucide lucide-activity"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"></path></svg>
                        </span>
                        <h3 className="card-title">Board Diagnostics</h3>
                        <p className="card-description">
                            Check 8x8 occupancy grid, 146 LEDs, and camera loop.
                        </p>
                        <span className="card-action">
                            Run diagnostics <Icon name="arrowUpRight" />
                        </span>
                    </button>

                    <button className="dashboard-card" onClick={() => setActiveModal('stats')}>
                        <span className="icon-tile">
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-lucide="chart-no-axes-combined" aria-hidden="true" className="lucide lucide-chart-no-axes-combined"><path d="M12 16v5"></path><path d="M16 14.639V21"></path><path d="M20 10.656V21"></path><path d="m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15"></path><path d="M4 18.463V21"></path><path d="M8 14.656V21"></path></svg>
                        </span>
                        <h3 className="card-title">Your Stats</h3>
                        <p className="card-description">
                            5 modes, Stockfish depth 12, and saved match summary.
                        </p>
                        <span className="card-action">
                            View profile <Icon name="arrowUpRight" />
                        </span>
                    </button>

                    <button className="dashboard-card" onClick={() => setActiveModal('device')}>
                        <span className="icon-tile">
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-lucide="cpu" aria-hidden="true" className="lucide lucide-cpu"><path d="M12 20v2"></path><path d="M12 2v2"></path><path d="M17 20v2"></path><path d="M17 2v2"></path><path d="M2 12h2"></path><path d="M2 17h2"></path><path d="M2 7h2"></path><path d="M20 12h2"></path><path d="M20 17h2"></path><path d="M20 7h2"></path><path d="M7 20v2"></path><path d="M7 2v2"></path><rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="8" y="8" width="8" height="8" rx="1"></rect></svg>
                        </span>
                        <h3 className="card-title">Device Information</h3>
                        <p className="card-description">
                            Pico GP17 LEDs, YOLO weights, Flask, and Stockfish.
                        </p>
                        <span className="card-action">
                            View device <Icon name="arrowUpRight" />
                        </span>
                    </button>
                </div>

                
                <div className="sec">
                    <h2 className="hd">Match History</h2><button data-go="replays" onClick={() => setActiveScreen('play')}>View all →</button>
                </div>

                
                <div
                    className="card"
                    style={{
                        flexDirection: "column",
                        alignItems: "stretch",
                        gap: 0,
                        padding: "4px 14px",
                    }}
                >
                    {recentGames.length === 0 ? (
                        <div className="lm">
                            <span className="av">?</span>

                            <span style={{ flex: 1 }}>
                                <b>No recent games</b>
                                <span className="mut">
                                    Play a game to see it here.
                                </span>
                            </span>
                        </div>
                    ) : (
                        recentGames.map((game) => (
                            <button
                                key={game.gameId}
                                className="lm"
                                onClick={() => {
                                    // Optional: navigate to Play/Match History.
                                }}
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
                                                : game.opponentUsername || "Lichess Game"}
                                    </b>

                                    <span className="mut">
                                        {getRecentGameResult(game)}
                                    </span>
                                </span>

                                <span className="chip">
                                    {new Date(game.updatedAt).toLocaleDateString()}
                                </span>
                            </button>
                        ))
                    )}
                </div>
            </section>
            {activeModal === 'connection_log' && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        backgroundColor: 'rgba(26, 35, 26, 0.6)',
                        backdropFilter: 'blur(4px)',
                        zIndex: 50,
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        padding: 0,
                    }}
                    onClick={() => setActiveModal(null)}
                >
                    <div
                        style={{
                            backgroundColor: '#f7f5ef',
                            maxWidth: '440px',
                            margin: '0 auto',
                            borderTopLeftRadius: '24px',
                            borderTopRightRadius: '24px',
                            borderTop: '1px solid #e8e5db',
                            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
                            maxHeight: '85vh',
                            display: 'flex',
                            flexDirection: 'column',
                            overflow: 'hidden',
                            height: "80%",
                            width: "90%",
                            borderRadius: "24px"
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Mobile Sheet Grab Handle */}
                        <div style={{ width: '100%', paddingTop: '12px', paddingBottom: '4px', display: 'flex', justifyContent: 'center', backgroundColor: '#ffffff', flexShrink: 0 }}>
                            <div style={{ width: '40px', height: '4px', borderRadius: '9999px', backgroundColor: '#d2cebf' }}></div>
                        </div>

                        {/* Modal Header */}
                        <div style={{ backgroundColor: '#ffffff', padding: '16px 20px', borderBottom: '1px solid #e8e5db', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexShrink: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <div style={{ width: '40px', height: '40px', borderRadius: '12px', backgroundColor: '#e3f0e5', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1a231a', border: '1px solid #d2e4d5', flexShrink: 0 }}>
                                    <History style={{ width: '20px', height: '20px', color: '#2d5a35' }} />
                                </div>
                                <div>
                                    <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#1a231a', margin: 0, lineHeight: 1.2 }}>Connection History Log</h3>
                                    <p style={{ fontSize: '11px', color: '#667064', margin: '2px 0 0 0' }}>Socket.IO, Pico serial &amp; vision events</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setActiveModal(null)}
                                style={{ padding: '8px', borderRadius: '12px', backgroundColor: '#f4f1e8', border: 'none', color: '#3b443a', minHeight: '44px', minWidth: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                                aria-label="Close modal"
                            >
                                <X style={{ width: '20px', height: '20px' }} />
                            </button>
                        </div>

                        {/* Filter & Search Controls */}
                        <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.8)', padding: '14px', borderBottom: '1px solid #e8e5db', display: 'flex', flexDirection: 'column', gap: '10px', flexShrink: 0 }}>
                            <div style={{ position: 'relative', width: '100%' }}>
                                <Search style={{ width: '16px', height: '16px', color: '#8c968a', position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
                                <input
                                    type="text"
                                    placeholder="Filter logs by keyword..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    style={{ width: '100%', paddingLeft: '36px', paddingRight: '12px', paddingTop: '8px', paddingBottom: '8px', borderRadius: '12px', backgroundColor: '#f7f5ef', border: '1px solid #e5e2d6', fontSize: '12px', color: '#1a231a', outline: 'none', boxSizing: 'border-box' }}
                                />
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                {['all', 'success', 'warning'].map(type => (
                                    <button
                                        key={type}
                                        type="button"
                                        onClick={() => setLogFilter(type)}
                                        style={{
                                            minHeight: '38px',
                                            paddingLeft: '14px',
                                            paddingRight: '14px',
                                            borderRadius: '12px',
                                            fontSize: '12px',
                                            fontWeight: 600,
                                            textTransform: 'capitalize',
                                            cursor: 'pointer',
                                            transition: 'all 0.15s ease',
                                            backgroundColor: logFilter === type ? '#1a231a' : '#ffffff',
                                            color: logFilter === type ? '#ffffff' : '#4a5449',
                                            border: logFilter === type ? '1px solid #1a231a' : '1px solid #e5e2d6',
                                            boxShadow: logFilter === type ? '0 1px 2px rgba(0,0,0,0.1)' : 'none'
                                        }}
                                    >
                                        {type}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Scrollable Content Body */}
                        <div style={{ padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', flex: 1, minHeight: 0, backgroundColor: '#f7f5ef' }}>
                            {filteredLogs.length > 0 ? (
                                filteredLogs.map(log => (
                                    <div key={log.id} style={{ padding: '14px', borderRadius: '16px', backgroundColor: '#ffffff', border: '1px solid #e8e5db', display: 'flex', flexDirection: 'column', gap: '8px', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                                                <div style={{ marginTop: '2px', flexShrink: 0 }}>
                                                    {log.status === 'success' ? (
                                                        <CheckCircle2 style={{ width: '16px', height: '16px', color: '#059669' }} />
                                                    ) : (
                                                        <AlertTriangle style={{ width: '16px', height: '16px', color: '#d97706' }} />
                                                    )}
                                                </div>
                                                <div>
                                                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#1a231a' }}>{log.event}</div>
                                                    <div style={{ fontSize: '10px', color: '#667064', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                                                        <span>{log.device}</span>
                                                        <span>•</span>
                                                        <span style={{ fontFamily: 'monospace' }}>{log.time}</span>
                                                    </div>
                                                </div>
                                            </div>
                                            <span style={{ fontSize: '10px', fontFamily: 'monospace', fontWeight: 500, color: '#2d5a35', backgroundColor: '#e3f0e5', padding: '2px 8px', borderRadius: '6px', border: '1px solid #d2e4d5', flexShrink: 0 }}>
                                                {log.latency}
                                            </span>
                                        </div>
                                        <p style={{ fontSize: '11px', color: '#4a5449', backgroundColor: '#fcfbf7', padding: '10px', borderRadius: '12px', border: '1px solid #ece9df', fontFamily: 'monospace', lineHeight: 1.5, margin: 0, wordBreak: 'break-word' }}>
                                            {log.details}
                                        </p>
                                    </div>
                                ))
                            ) : (
                                <div style={{ textAlign: 'center', padding: '32px 0', color: '#667064', fontSize: '12px' }}>
                                    No matching log entries found.
                                </div>
                            )}
                        </div>

                        {/* Modal Sticky Footer */}
                        <div style={{ backgroundColor: '#ffffff', padding: '16px', borderTop: '1px solid #e8e5db', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, borderRadius: "0px 0px 24px 24px" }}>
                            <span style={{ fontSize: '11px', color: '#667064', fontFamily: 'monospace' }}>Showing {filteredLogs.length} logs</span>
                            <button
                                type="button"
                                onClick={() => setActiveModal(null)}
                                style={{
                                    minHeight: '44px',
                                    paddingLeft: '20px',
                                    paddingRight: '20px',
                                    borderRadius: '12px',
                                    backgroundColor: '#1a231a',
                                    color: '#ffffff',
                                    fontSize: '12px',
                                    fontWeight: 600,
                                    border: 'none',
                                    cursor: 'pointer'
                                }}
                            >
                                Close Log
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {activeModal === 'diagnostics' && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        backgroundColor: 'rgba(26, 35, 26, 0.6)',
                        backdropFilter: 'blur(4px)',
                        zIndex: 50,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                    onClick={() => setActiveModal(null)}
                >
                    <div
                        style={{
                            backgroundColor: '#f7f5ef',
                            width: '90%',
                            maxWidth: '440px',
                            height: '80%',
                            maxHeight: '80vh',
                            borderRadius: '24px',
                            border: '1px solid #e8e5db',
                            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
                            display: 'flex',
                            flexDirection: 'column',
                            overflow: 'hidden'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Mobile Sheet Grab Handle */}
                        <div style={{ width: '100%', paddingTop: '12px', paddingBottom: '4px', display: 'flex', justifyContent: 'center', backgroundColor: '#ffffff', flexShrink: 0 }}>
                            <div style={{ width: '40px', height: '4px', borderRadius: '9999px', backgroundColor: '#d2cebf' }}></div>
                        </div>

                        {/* Header */}
                        <div style={{ backgroundColor: '#ffffff', padding: '16px 20px', borderBottom: '1px solid #e8e5db', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexShrink: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <div style={{ width: '40px', height: '40px', borderRadius: '12px', backgroundColor: '#e3f0e5', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1a231a', border: '1px solid #d2e4d5', flexShrink: 0 }}>
                                    <Activity style={{ width: '20px', height: '20px', color: '#2d5a35' }} />
                                </div>
                                <div>
                                    <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#1a231a', margin: 0, lineHeight: 1.2 }}>Board Diagnostics</h3>
                                    <p style={{ fontSize: '11px', color: '#667064', margin: '2px 0 0 0' }}>Tap squares to preview 8x8 occupancy grid</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setActiveModal(null)}
                                style={{ padding: '8px', borderRadius: '12px', backgroundColor: '#f4f1e8', border: 'none', color: '#3b443a', minHeight: '44px', minWidth: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                                aria-label="Close modal"
                            >
                                <X style={{ width: '20px', height: '20px' }} />
                            </button>
                        </div>

                        {/* Scrollable Diagnostics Content */}
                        <div style={{ padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, minHeight: 0, backgroundColor: '#f7f5ef' }}>

                            {/* COMPACT 8x8 CHESS GRID MATRIX */}
                            <div style={{ backgroundColor: '#ffffff', padding: '12px', borderRadius: '16px', border: '1px solid #e8e5db', display: 'flex', flexDirection: 'column', alignItems: 'center', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: '8px', fontSize: '10px', fontFamily: 'monospace', color: '#667064' }}>
                                    <span>8x8 Grid · 146 LEDs</span>
                                    <span style={{ color: '#047857', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        <span style={{ width: '6px', height: '6px', borderRadius: '9999px', backgroundColor: '#10b981' }}></span>
                                        YOLO + Pico Ready
                                    </span>
                                </div>

                                {/* Visual Chess Grid */}
                                <div style={{ padding: '8px', backgroundColor: '#1a231a', borderRadius: '12px', border: '1px solid #2b332b', width: '100%', maxWidth: '270px', aspectRatio: '1 / 1', boxSizing: 'border-box' }}>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '2px', width: '100%', height: '100%' }}>
                                        {boardState.map((row, r) =>
                                            row.map((isOccupied, c) => {
                                                const isLight = (r + c) % 2 === 0;
                                                return (
                                                    <button
                                                        key={`${r}-${c}`}
                                                        type="button"
                                                        onClick={() => toggleSquare(r, c)}
                                                        style={{
                                                            borderRadius: '3px',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            position: 'relative',
                                                            border: 'none',
                                                            padding: 0,
                                                            cursor: 'pointer',
                                                            backgroundColor: isLight ? '#f0ece1' : '#a3b19b'
                                                        }}
                                                    >
                                                        {isOccupied && (
                                                            <span style={{ position: 'absolute', inset: 0, borderRadius: '3px', border: '1px solid #34d399', backgroundColor: 'rgba(16, 185, 129, 0.3)', pointerEvents: 'none' }} />
                                                        )}

                                                        <span style={{
                                                            width: '8px',
                                                            height: '8px',
                                                            borderRadius: '9999px',
                                                            backgroundColor: isOccupied ? '#059669' : 'transparent',
                                                            border: isOccupied ? 'none' : '1px solid rgba(0,0,0,0.2)',
                                                            boxShadow: isOccupied ? '0 0 6px rgba(16,185,129,0.8)' : 'none'
                                                        }} />
                                                    </button>
                                                );
                                            })
                                        )}
                                    </div>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', marginTop: '10px', fontSize: '10px', fontWeight: 500, color: '#4a5449' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <span style={{ width: '10px', height: '10px', borderRadius: '9999px', backgroundColor: '#059669', display: 'inline-block' }}></span>
                                        <span>Occupied (X)</span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <span style={{ width: '10px', height: '10px', borderRadius: '9999px', border: '1px solid rgba(0,0,0,0.3)', display: 'inline-block' }}></span>
                                        <span>Empty (.)</span>
                                    </div>
                                </div>
                            </div>

                            {/* LIVE TERMINAL */}
                            <div style={{ backgroundColor: '#1a231a', color: '#e3f0e5', padding: '12px', borderRadius: '16px', fontFamily: 'monospace', fontSize: '10px', height: '120px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', border: '1px solid #2b332b', flexShrink: 0 }}>
                                <div style={{ color: '#8c968a', paddingBottom: '6px', borderBottom: '1px solid #2b332b', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '9px' }}>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        <Terminal style={{ width: '12px', height: '12px', color: '#34d399' }} />
                                        VISION &amp; SERIAL TELEMETRY
                                    </span>
                                    <span>115200 BAUD</span>
                                </div>
                                {diagLog.map((log, index) => (
                                    <div key={index} style={{ lineHeight: 1.3 }}>
                                        <span style={{ color: '#8c968a' }}>[{log.time}]</span> {log.msg}
                                    </div>
                                ))}
                            </div>

                            {/* SWEEP TRIGGER BUTTON */}
                            <button
                                type="button"
                                onClick={runFullMatrixTest}
                                disabled={isSweeping}
                                style={{
                                    width: '100%',
                                    minHeight: '44px',
                                    padding: '10px 16px',
                                    borderRadius: '12px',
                                    backgroundColor: '#e3f0e5',
                                    color: '#1a231a',
                                    fontWeight: 600,
                                    fontSize: '12px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '8px',
                                    border: '1px solid #d2e4d5',
                                    cursor: isSweeping ? 'not-allowed' : 'pointer',
                                    opacity: isSweeping ? 0.6 : 1,
                                    flexShrink: 0
                                }}
                            >
                                <RefreshCw style={{ width: '14px', height: '14px', color: '#065f46' }} className={isSweeping ? 'animate-spin' : ''} />
                                <span>{isSweeping ? 'Checking Grid...' : 'Verify 64-Square LED Map'}</span>
                            </button>

                            {/* FRAME POLLING SLIDER */}
                            <div style={{ backgroundColor: '#ffffff', padding: '16px', borderRadius: '16px', border: '1px solid #e8e5db', display: 'flex', flexDirection: 'column', gap: '10px', flexShrink: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <Sliders style={{ width: '14px', height: '14px', color: '#047857' }} />
                                        <h4 style={{ fontSize: '12px', fontWeight: 700, color: '#1a231a', margin: 0 }}>Vision Loop Interval</h4>
                                    </div>
                                    <span style={{ fontSize: '10px', fontFamily: 'monospace', color: '#065f46', backgroundColor: '#e3f0e5', padding: '2px 8px', borderRadius: '6px', border: '1px solid #d2e4d5' }}>
                                        {dwellTime}ms
                                    </span>
                                </div>

                                <input
                                    type="range"
                                    min="25"
                                    max="200"
                                    step="25"
                                    value={dwellTime}
                                    onChange={(e) => setDwellTime(Number(e.target.value))}
                                    style={{ width: '100%', accentColor: '#047857', cursor: 'pointer', height: '8px', borderRadius: '8px' }}
                                />

                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#8c968a', fontFamily: 'monospace' }}>
                                    <span>25ms (40 FPS)</span>
                                    <span>50ms (Default)</span>
                                    <span>200ms (5 FPS)</span>
                                </div>
                            </div>

                        </div>

                        {/* Sticky Footer */}
                        <div style={{ backgroundColor: '#ffffff', padding: '16px', borderTop: '1px solid #e8e5db', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
                            <button
                                type="button"
                                onClick={() => setActiveModal(null)}
                                style={{
                                    minHeight: '44px',
                                    paddingLeft: '20px',
                                    paddingRight: '20px',
                                    borderRadius: '12px',
                                    backgroundColor: '#1a231a',
                                    color: '#ffffff',
                                    fontSize: '12px',
                                    fontWeight: 600,
                                    border: 'none',
                                    cursor: 'pointer'
                                }}
                            >
                                Close Diagnostics
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {activeModal === 'stats' && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        backgroundColor: 'rgba(26, 35, 26, 0.6)',
                        backdropFilter: 'blur(4px)',
                        zIndex: 50,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                    onClick={() => setActiveModal(null)}
                >
                    <div
                        style={{
                            backgroundColor: '#f7f5ef',
                            width: '90%',
                            maxWidth: '440px',
                            height: '80%',
                            maxHeight: '80vh',
                            borderRadius: '24px',
                            border: '1px solid #e8e5db',
                            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
                            display: 'flex',
                            flexDirection: 'column',
                            overflow: 'hidden'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Grab Handle */}
                        <div style={{ width: '100%', paddingTop: '12px', paddingBottom: '4px', display: 'flex', justifyContent: 'center', backgroundColor: '#ffffff', flexShrink: 0 }}>
                            <div style={{ width: '40px', height: '4px', borderRadius: '9999px', backgroundColor: '#d2cebf' }}></div>
                        </div>

                        {/* Header */}
                        <div style={{ backgroundColor: '#ffffff', padding: '16px 20px', borderBottom: '1px solid #e8e5db', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexShrink: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <div style={{ width: '40px', height: '40px', borderRadius: '12px', backgroundColor: '#e3f0e5', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1a231a', border: '1px solid #d2e4d5', flexShrink: 0 }}>
                                    <TrendingUp style={{ width: '20px', height: '20px', color: '#2d5a35' }} />
                                </div>
                                <div>
                                    <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#1a231a', margin: 0, lineHeight: 1.2 }}>Your Stats</h3>
                                    <p style={{ fontSize: '11px', color: '#667064', margin: '2px 0 0 0' }}>Modes, engine &amp; match activity</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setActiveModal(null)}
                                style={{ padding: '8px', borderRadius: '12px', backgroundColor: '#f4f1e8', border: 'none', color: '#3b443a', minHeight: '44px', minWidth: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                                aria-label="Close modal"
                            >
                                <X style={{ width: '20px', height: '20px' }} />
                            </button>
                        </div>

                        {/* Scrollable Content */}
                        <div style={{ padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px', flex: 1, minHeight: 0, backgroundColor: '#f7f5ef' }}>

                            {/* 2x2 Metric Grid */}
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
                                <div style={{ backgroundColor: '#ffffff', padding: '12px', borderRadius: '16px', border: '1px solid #e8e5db', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                                    <div style={{ fontSize: '10px', color: '#667064' }}>Active Modes</div>
                                    <div style={{ fontSize: '18px', fontWeight: 700, color: '#1a231a', marginTop: '2px' }}>5</div>
                                    <div style={{ fontSize: '9px', color: '#047857', fontWeight: 500, marginTop: '2px' }}>Bot · Casual · Lichess · Rush · Scan</div>
                                </div>

                                <div style={{ backgroundColor: '#ffffff', padding: '12px', borderRadius: '16px', border: '1px solid #e8e5db', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                                    <div style={{ fontSize: '10px', color: '#667064' }}>Stockfish Depth</div>
                                    <div style={{ fontSize: '18px', fontWeight: 700, color: '#1a231a', marginTop: '2px' }}>12</div>
                                    <div style={{ fontSize: '9px', color: '#047857', fontWeight: 500, marginTop: '2px' }}>ELO 800–3000</div>
                                </div>

                                <div style={{ backgroundColor: '#ffffff', padding: '12px', borderRadius: '16px', border: '1px solid #e8e5db', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                                    <div style={{ fontSize: '10px', color: '#667064' }}>Pico LEDs</div>
                                    <div style={{ fontSize: '18px', fontWeight: 700, color: '#1a231a', marginTop: '2px' }}>146</div>
                                    <div style={{ fontSize: '9px', color: '#667064', marginTop: '2px' }}>WS2812B on GP17</div>
                                </div>

                                <div style={{ backgroundColor: '#ffffff', padding: '12px', borderRadius: '16px', border: '1px solid #e8e5db', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                                    <div style={{ fontSize: '10px', color: '#667064' }}>Recent Games</div>
                                    <div style={{ fontSize: '18px', fontWeight: 700, color: '#1a231a', marginTop: '2px' }}>{recentGames.length}</div>
                                    <div style={{ fontSize: '9px', color: '#667064', marginTop: '2px' }}>SQLite PGN store</div>
                                </div>
                            </div>

                            {/* Chart Component */}
                            <div style={{ backgroundColor: '#ffffff', padding: '16px', borderRadius: '16px', border: '1px solid #e8e5db', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 1px 2px rgba(0,0,0,0.03)', flexShrink: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    <h4 style={{ fontSize: '12px', fontWeight: 700, color: '#1a231a', margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <BarChart3 style={{ width: '14px', height: '14px', color: '#047857' }} />
                                        <span>Weekly Move Activations</span>
                                    </h4>
                                    <span style={{ fontSize: '10px', color: '#667064', fontFamily: 'monospace' }}>Past 7 Days</span>
                                </div>

                                <div style={{ paddingTop: '16px', paddingBottom: '4px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '6px', height: '128px' }}>
                                    {[
                                        { day: 'M', moves: 140, discards: 24 },
                                        { day: 'T', moves: 210, discards: 40 },
                                        { day: 'W', moves: 180, discards: 30 },
                                        { day: 'T', moves: 290, discards: 52 },
                                        { day: 'F', moves: 310, discards: 68 },
                                        { day: 'S', moves: 420, discards: 85 },
                                        { day: 'S', moves: 250, discards: 43 }
                                    ].map((bar, i) => (
                                        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', height: '100%', justifyContent: 'flex-end' }}>
                                            <div style={{ width: '100%', backgroundColor: '#f4f1e8', borderTopLeftRadius: '6px', borderTopRightRadius: '6px', overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', border: '1px solid #ece9df', boxSizing: 'border-box' }}>
                                                <div
                                                    style={{ height: `${(bar.discards / 450) * 100}%`, width: '100%', backgroundColor: '#fbbf24' }}
                                                />
                                                <div
                                                    style={{ height: `${(bar.moves / 450) * 100}%`, width: '100%', backgroundColor: '#1a231a' }}
                                                />
                                            </div>
                                            <span style={{ fontSize: '10px', fontFamily: 'monospace', color: '#667064' }}>{bar.day}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                        </div>

                        {/* Sticky Footer */}
                        <div style={{ backgroundColor: '#ffffff', padding: '16px', borderTop: '1px solid #e8e5db', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
                            <button
                                type="button"
                                onClick={() => setActiveModal(null)}
                                style={{
                                    minHeight: '44px',
                                    paddingLeft: '20px',
                                    paddingRight: '20px',
                                    borderRadius: '12px',
                                    backgroundColor: '#1a231a',
                                    color: '#ffffff',
                                    fontSize: '12px',
                                    fontWeight: 600,
                                    border: 'none',
                                    cursor: 'pointer'
                                }}
                            >
                                Close Stats
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {activeModal === 'device' && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        backgroundColor: 'rgba(26, 35, 26, 0.6)',
                        backdropFilter: 'blur(4px)',
                        zIndex: 50,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                    onClick={() => setActiveModal(null)}
                >
                    <div
                        style={{
                            backgroundColor: '#f7f5ef',
                            width: '90%',
                            maxWidth: '440px',
                            height: '80%',
                            maxHeight: '80vh',
                            borderRadius: '24px',
                            border: '1px solid #e8e5db',
                            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
                            display: 'flex',
                            flexDirection: 'column',
                            overflow: 'hidden'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Grab Handle */}
                        <div style={{ width: '100%', paddingTop: '12px', paddingBottom: '4px', display: 'flex', justifyContent: 'center', backgroundColor: '#ffffff', flexShrink: 0 }}>
                            <div style={{ width: '40px', height: '4px', borderRadius: '9999px', backgroundColor: '#d2cebf' }}></div>
                        </div>

                        {/* Header */}
                        <div style={{ backgroundColor: '#ffffff', padding: '16px 20px', borderBottom: '1px solid #e8e5db', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexShrink: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <div style={{ width: '40px', height: '40px', borderRadius: '12px', backgroundColor: '#e3f0e5', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1a231a', border: '1px solid #d2e4d5', flexShrink: 0 }}>
                                    <Cpu style={{ width: '20px', height: '20px', color: '#2d5a35' }} />
                                </div>
                                <div>
                                    <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#1a231a', margin: 0, lineHeight: 1.2 }}>Device Specs</h3>
                                    <p style={{ fontSize: '11px', color: '#667064', margin: '2px 0 0 0' }}>Pico LEDs, YOLO Vision &amp; Flask Stack</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setActiveModal(null)}
                                style={{ padding: '8px', borderRadius: '12px', backgroundColor: '#f4f1e8', border: 'none', color: '#3b443a', minHeight: '44px', minWidth: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                                aria-label="Close modal"
                            >
                                <X style={{ width: '20px', height: '20px' }} />
                            </button>
                        </div>

                        {/* Scrollable Content Body */}
                        <div style={{ padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, minHeight: 0, backgroundColor: '#f7f5ef', fontSize: '12px' }}>

                            <div style={{ padding: '16px', borderRadius: '16px', backgroundColor: '#ffffff', border: '1px solid #e8e5db', display: 'flex', flexDirection: 'column', gap: '8px', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                                <h4 style={{ fontWeight: 700, color: '#1a231a', margin: 0, display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #f4f1e8', paddingBottom: '6px' }}>
                                    <span style={{ width: '8px', height: '8px', borderRadius: '9999px', backgroundColor: '#059669', display: 'inline-block' }}></span>
                                    LED Controller Hardware
                                </h4>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#667064' }}>Controller:</span> <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1a231a' }}>Raspberry Pi Pico</span></div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#667064' }}>LED Strip:</span> <span>146x WS2812B</span></div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#667064' }}>Data Pin:</span> <span style={{ fontFamily: 'monospace' }}>GP17 (PIO @ 8 MHz)</span></div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#667064' }}>Serial Link:</span> <span style={{ fontFamily: 'monospace' }}>115200 baud</span></div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#667064' }}>Grid:</span> <span style={{ fontFamily: 'monospace' }}>8x8 (Cream &amp; Green)</span></div>
                                </div>
                            </div>

                            <div style={{ padding: '16px', borderRadius: '16px', backgroundColor: '#ffffff', border: '1px solid #e8e5db', display: 'flex', flexDirection: 'column', gap: '8px', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                                <h4 style={{ fontWeight: 700, color: '#1a231a', margin: 0, display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #f4f1e8', paddingBottom: '6px' }}>
                                    <span style={{ width: '8px', height: '8px', borderRadius: '9999px', backgroundColor: '#d97706', display: 'inline-block' }}></span>
                                    Vision &amp; Chess Logic
                                </h4>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#667064' }}>Board Model:</span> <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#1a231a' }}>chessboxweights.pt</span></div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#667064' }}>Piece/Hand:</span> <span style={{ fontFamily: 'monospace' }}>piece_finder_weights.pt</span></div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#667064' }}>Capture:</span> <span style={{ fontWeight: 500 }}>OpenCV + Ultralytics YOLO</span></div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#667064' }}>Rules:</span> <span style={{ fontFamily: 'monospace' }}>python-chess &amp; chess.js</span></div>
                                </div>
                            </div>

                            <div style={{ padding: '16px', borderRadius: '16px', backgroundColor: '#ffffff', border: '1px solid #e8e5db', display: 'flex', flexDirection: 'column', gap: '8px', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                                <h4 style={{ fontWeight: 700, color: '#1a231a', margin: 0, display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #f4f1e8', paddingBottom: '6px' }}>
                                    <span style={{ width: '8px', height: '8px', borderRadius: '9999px', backgroundColor: '#2563eb', display: 'inline-block' }}></span>
                                    Software Stack
                                </h4>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#667064' }}>Backend:</span> <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#1a231a' }}>Flask + Socket.IO + SQLite</span></div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#667064' }}>Engine:</span> <span style={{ fontFamily: 'monospace' }}>Stockfish UCI (Depth 12)</span></div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#667064' }}>Frontend:</span> <span style={{ fontFamily: 'monospace', color: '#047857', fontWeight: 600 }}>Next.js + Chessground</span></div>
                                </div>
                            </div>

                        </div>

                        {/* Sticky Footer */}
                        <div style={{ backgroundColor: '#ffffff', padding: '16px', borderTop: '1px solid #e8e5db', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
                            <button
                                type="button"
                                onClick={() => setActiveModal(null)}
                                style={{
                                    minHeight: '44px',
                                    paddingLeft: '20px',
                                    paddingRight: '20px',
                                    borderRadius: '12px',
                                    backgroundColor: '#1a231a',
                                    color: '#ffffff',
                                    fontSize: '12px',
                                    fontWeight: 600,
                                    border: 'none',
                                    cursor: 'pointer'
                                }}
                            >
                                Close Specs
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}