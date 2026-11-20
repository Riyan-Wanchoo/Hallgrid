"use client";

import { useEffect, useRef, useState } from "react";
import { Socket } from "socket.io-client";

type ScanPhase = "idle" | "scanning" | "live_occupancy" | "error";

type ScanState = {
  phase: ScanPhase;
  message: string;
  occupiedSquares: string[];
  lastUpdated: string | null;
};

const initialScanState: ScanState = {
  phase: "idle",
  message: "Press Start Scan to check camera & LED occupancy.",
  occupiedSquares: [],
  lastUpdated: null,
};

export default function Scan({
  socket,
  isConnected,
}: {
  socket: Socket | null;
  isConnected: boolean;
}) {
  const [state, setState] = useState<ScanState>(initialScanState);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!socket) return;

    socketRef.current = socket;

    const handleScanStarted = (data?: { message?: string }) => {
      setState((current) => ({
        ...current,
        phase: "scanning",
        message: data?.message ?? "Scanning board...",
      }));
    };

    const handleScanOccupancy = (data?: {
      occupiedSquares?: string[];
      message?: string;
    }) => {
      const squares = Array.isArray(data?.occupiedSquares)
        ? data.occupiedSquares
        : [];
      setState({
        phase: "live_occupancy",
        message:
          data?.message ??
          (squares.length > 0
            ? `Occupied (${squares.length}): ${squares.join(", ")}`
            : "Board clear (0 pieces detected)."),
        occupiedSquares: squares,
        lastUpdated: new Date().toLocaleTimeString(),
      });
    };

    const handleScanState = (data?: {
      phase?: ScanPhase;
      message?: string;
      occupiedSquares?: string[];
    }) => {
      if (!data) return;
      setState((current) => ({
        ...current,
        phase: data.phase ?? current.phase,
        message: data.message ?? current.message,
        occupiedSquares: Array.isArray(data.occupiedSquares)
          ? data.occupiedSquares
          : current.occupiedSquares,
        lastUpdated: new Date().toLocaleTimeString(),
      }));
    };

    const handleScanStopped = (data?: { message?: string }) => {
      setState({
        ...initialScanState,
        message: data?.message ?? "Scan stopped.",
      });
    };

    const handleScanError = (data?: { message?: string }) => {
      setState((current) => ({
        ...current,
        phase: "error",
        message: data?.message ?? "Scan error occurred.",
      }));
    };

    socket.on("scan_started", handleScanStarted);
    socket.on("scan_occupancy", handleScanOccupancy);
    socket.on("scan_state", handleScanState);
    socket.on("scan_stopped", handleScanStopped);
    socket.on("scan_error", handleScanError);

    return () => {
      socket.off("scan_started", handleScanStarted);
      socket.off("scan_occupancy", handleScanOccupancy);
      socket.off("scan_state", handleScanState);
      socket.off("scan_stopped", handleScanStopped);
      socket.off("scan_error", handleScanError);
    };
  }, [socket]);

  const startScan = () => {
    if (!socketRef.current || !isConnected) return;

    setState({
      phase: "scanning",
      message: "Scanning board...",
      occupiedSquares: [],
      lastUpdated: null,
    });

    socketRef.current.emit("scan_start");
  };

  const stopScan = () => {
    if (!socketRef.current) return;

    socketRef.current.emit("scan_stop");

    setState({
      ...initialScanState,
      message: "Scan stopped.",
    });
  };

  const isActive = state.phase === "scanning" || state.phase === "live_occupancy";

  return (
    <section id="replays" className="scr on">
      <div className="scan-page">
        <header className="scan-header">
          <span className="scan-eyebrow">CAMERA &amp; LED DIAGNOSTIC</span>

          <h1 className="hd scan-heading">Board Scan</h1>

          <p className="mut scan-subheading">
            Verify piece detection and live red LED square feedback.
          </p>
        </header>

        <div className="scan-card">
          <div className="scan-card-top">
            <span className="scan-tag">OCCUPANCY MONITOR</span>

            <span className="scan-engine">
              <span
                className={`scan-engine-dot ${
                  state.phase === "live_occupancy"
                    ? "live"
                    : state.phase === "scanning"
                      ? "pulse"
                      : ""
                }`}
              />
              {state.phase === "live_occupancy"
                ? "Live Red LEDs"
                : state.phase === "scanning"
                  ? "Scanning"
                  : "Standby"}
            </span>
          </div>

          <div className="scan-status">
            <span
              className={`scan-status-dot ${
                state.phase === "live_occupancy"
                  ? "live"
                  : state.phase === "scanning"
                    ? "pulse"
                    : state.phase === "error"
                      ? "err"
                      : ""
              }`}
            />

            <span className="scan-status-text">{state.message}</span>
          </div>

          <div className="scan-art" aria-hidden="true">
            <div className="scan-mini-board">
              {Array.from({ length: 16 }, (_, index) => {
                const row = Math.floor(index / 4);
                const column = index % 4;

                return (
                  <span
                    key={index}
                    className={
                      (row + column) % 2 === 0
                        ? "scan-square scan-square-light"
                        : "scan-square scan-square-dark"
                    }
                  />
                );
              })}
            </div>

            <svg
              className={`scan-frame ${
                state.phase === "scanning" ? "is-scanning" : ""
              }`}
              viewBox="0 0 160 160"
              fill="none"
            >
              <path
                d="
                  M15 43V23Q15 15 23 15H43
                  M117 15H137Q145 15 145 23V43
                  M145 117V137Q145 145 137 145H117
                  M43 145H23Q15 145 15 137V117
                "
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <path
                className="scan-beam"
                d="M25 80H135"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                opacity=".55"
              />
            </svg>
          </div>

          <div className="scan-meta-row">
            <span className="scan-meta-label">Detected Pieces</span>
            <span className="scan-meta-value">
              {isActive ? state.occupiedSquares.length : "--"}
            </span>
          </div>

          {isActive && state.occupiedSquares.length > 0 && (
            <div className="scan-squares-box">
              {state.occupiedSquares.map((sq) => (
                <span key={sq} className="scan-sq-chip">
                  {sq}
                </span>
              ))}
            </div>
          )}

          <div className="scan-actions">
            {!isActive ? (
              <button
                type="button"
                className="scan-button"
                disabled={!isConnected}
                onClick={startScan}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
                  <path d="M7 12h10" />
                </svg>
                Start Scan
              </button>
            ) : (
              <button
                type="button"
                className="scan-button scan-stop-button"
                onClick={stopScan}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
                Stop Scan
              </button>
            )}
          </div>

          <p className="scan-note">
            {!isActive
              ? "Starts a scan wave first, then switches to red LEDs on occupied squares over a normal white-and-green board."
              : "Move pieces and remove your hand to refresh red LEDs immediately."}
          </p>
        </div>

        <section className="scan-guide" aria-labelledby="scan-guide-title">
          <div className="scan-guide-heading">
            <h2 id="scan-guide-title">How Scan Mode Works</h2>
            <span>3 steps</span>
          </div>

          <ol className="scan-steps">
            <li className="scan-step">
              <span className="scan-step-number">01</span>
              <div className="scan-step-copy">
                <h3>Start the scan wave</h3>
                <p>
                  Press Start Scan to open the camera and play the initial scanning
                  animation until a clean frame is captured.
                </p>
              </div>
            </li>

            <li className="scan-step">
              <span className="scan-step-number">02</span>
              <div className="scan-step-copy">
                <h3>View red occupied squares</h3>
                <p>
                  The scan animation stops and switches to solid red under squares
                  with pieces, keeping the rest of the board white-and-green.
                </p>
              </div>
            </li>

            <li className="scan-step">
              <span className="scan-step-number">03</span>
              <div className="scan-step-copy">
                <h3>Move pieces &amp; clear your hand</h3>
                <p>
                  Rearrange pieces and remove your hand so YOLO updates the red LEDs
                  to the new occupied squares without replaying the scan wave.
                </p>
              </div>
            </li>
          </ol>
        </section>
      </div>

      <style>{`
        .scan-page {
          --scan-ink: #1a2f23;
          --scan-muted: #788577;

          display: flex;
          flex-direction: column;
          gap: 26px;
          max-width: 480px;
          margin: 0 auto;
          padding: 8px 0 28px;
          color: var(--scan-ink);
        }

        .scan-page * {
          box-sizing: border-box;
        }

        .scan-header {
          padding: 0 2px;
        }

        .scan-eyebrow {
          display: block;
          margin-bottom: 10px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 1.7px;
          color: var(--scan-muted);
        }

        .scan-heading {
          margin: 0 0 8px;
          font-size: clamp(27px, 7vw, 34px);
          line-height: 1.15;
          letter-spacing: -1px;
        }

        .scan-subheading {
          margin: 0;
          font-size: 14px;
          line-height: 1.6;
        }

        .scan-card {
          position: relative;
          overflow: hidden;
          padding: 22px;
          border: 1px solid rgba(26, 47, 35, 0.08);
          border-radius: 26px;
          background: #fffdf8;
          box-shadow: 0 8px 30px rgba(26, 47, 35, 0.035);
        }

        .scan-card-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 10px;
        }

        .scan-tag {
          font-size: 9px;
          font-weight: 750;
          letter-spacing: 1.3px;
          color: var(--scan-muted);
        }

        .scan-engine {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 9px;
          border-radius: 20px;
          background: rgba(26, 47, 35, 0.055);
          font-size: 10px;
          font-weight: 600;
          color: var(--scan-ink);
        }

        .scan-engine-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--scan-muted);
        }

        .scan-engine-dot.live {
          background: #d93829;
        }

        .scan-engine-dot.pulse {
          background: #2d7a4b;
          animation: scanPulse 1.1s ease-in-out infinite;
        }

        .scan-status {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 18px;
          padding: 10px 12px;
          border-radius: 12px;
          background: rgba(26, 47, 35, 0.04);
        }

        .scan-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
          background: var(--scan-muted);
        }

        .scan-status-dot.live {
          background: #d93829;
        }

        .scan-status-dot.pulse {
          background: #2d7a4b;
          animation: scanPulse 1.1s ease-in-out infinite;
        }

        .scan-status-dot.err {
          background: #c0553b;
        }

        .scan-status-text {
          font-size: 12px;
          font-weight: 600;
          line-height: 1.4;
        }

        .scan-art {
          position: relative;
          display: grid;
          place-items: center;
          width: 160px;
          height: 160px;
          margin: 20px auto 16px;
        }

        .scan-mini-board {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          width: 108px;
          height: 108px;
          overflow: hidden;
          border-radius: 9px;
          opacity: 0.9;
        }

        .scan-square-light {
          background: #ede9dc;
        }

        .scan-square-dark {
          background: #8d9d87;
        }

        .scan-frame {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          color: var(--scan-ink);
        }

        .scan-frame.is-scanning .scan-beam {
          animation: scanSweep 1.5s ease-in-out infinite;
        }

        .scan-meta-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          border: 1px solid rgba(26, 47, 35, 0.08);
          border-radius: 12px;
          background: rgba(26, 47, 35, 0.03);
        }

        .scan-meta-label {
          font-size: 11px;
          font-weight: 650;
          color: var(--scan-muted);
        }

        .scan-meta-value {
          font-size: 13px;
          font-weight: 750;
          font-variant-numeric: tabular-nums;
          color: var(--scan-ink);
        }

        .scan-squares-box {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 10px;
        }

        .scan-sq-chip {
          padding: 4px 8px;
          border-radius: 8px;
          background: rgba(217, 56, 41, 0.1);
          border: 1px solid rgba(217, 56, 41, 0.25);
          color: #9e2217;
          font-size: 11px;
          font-weight: 700;
          font-family: monospace;
          text-transform: uppercase;
        }

        .scan-actions {
          margin-top: 18px;
        }

        .scan-button {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          width: 100%;
          min-height: 52px;
          padding: 14px 18px;
          border: 0;
          border-radius: 14px;
          background: var(--scan-ink);
          color: #fffdf8;
          font: inherit;
          font-size: 14px;
          font-weight: 650;
          cursor: pointer;
          transition: background 0.18s ease, transform 0.18s ease;
        }

        .scan-button:hover {
          background: #294735;
        }

        .scan-button:active {
          transform: scale(0.985);
        }

        .scan-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .scan-button:focus-visible {
          outline: 3px solid #81b88b;
          outline-offset: 4px;
        }

        .scan-note {
          margin: 12px 0 0;
          text-align: center;
          color: var(--scan-muted);
          font-size: 10px;
          line-height: 1.6;
        }

        .scan-guide {
          padding: 0 4px;
        }

        .scan-guide-heading {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 20px;
        }

        .scan-guide-heading h2 {
          margin: 0;
          font-size: 15px;
          font-weight: 700;
          letter-spacing: -0.3px;
        }

        .scan-guide-heading > span {
          color: var(--scan-muted);
          font-size: 11px;
        }

        .scan-steps {
          display: flex;
          flex-direction: column;
          margin: 0;
          padding: 0;
          list-style: none;
        }

        .scan-step {
          position: relative;
          display: flex;
          align-items: flex-start;
          gap: 14px;
          padding-bottom: 23px;
        }

        .scan-step:not(:last-child)::after {
          content: "";
          position: absolute;
          top: 38px;
          bottom: 6px;
          left: 17px;
          width: 1px;
          background: rgba(26, 47, 35, 0.12);
        }

        .scan-step:last-child {
          padding-bottom: 0;
        }

        .scan-step-number {
          display: grid;
          flex: 0 0 35px;
          place-items: center;
          height: 35px;
          border: 1px solid rgba(26, 47, 35, 0.1);
          border-radius: 11px;
          background: rgba(255, 253, 248, 0.7);
          color: var(--scan-ink);
          font-size: 11px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }

        .scan-step-copy {
          padding-top: 1px;
        }

        .scan-step-copy h3 {
          margin: 0 0 5px;
          font-size: 13px;
          font-weight: 700;
        }

        .scan-step-copy p {
          margin: 0;
          color: var(--scan-muted);
          font-size: 12px;
          line-height: 1.7;
        }

        @keyframes scanSweep {
          0%, 100% {
            transform: translateY(-28px);
          }
          50% {
            transform: translateY(28px);
          }
        }

        @keyframes scanPulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.35;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .scan-button,
          .scan-frame.is-scanning .scan-beam,
          .scan-engine-dot.pulse,
          .scan-status-dot.pulse {
            transition: none;
            animation: none;
          }
        }
      `}</style>
    </section>
  );
}