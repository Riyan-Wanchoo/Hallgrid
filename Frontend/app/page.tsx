"use client";

import Home from "../components/Home";
import Play from "../components/Play";
import Navbar from "../components/Navbar";
import Puzzles from "../components/Puzzles";
import Scan from "../components/Scan";
import Profile from "../components/Profile";
import { useEffect, useState } from "react";
import { io, Socket } from "socket.io-client";

export default function Page() {
  const [activeScreen, setActiveScreen] = useState<string>("home");
  const [isConnected, setIsConnected] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const socketInstance: Socket = io("http://127.0.0.1:5000", {
      transports: ["websocket", "polling"],
    });

    socketInstance.on("connect", () => setIsConnected(true));
    socketInstance.on("disconnect", () => setIsConnected(false));
    socketInstance.on("connect_error", () => setIsConnected(false));

    socketInstance.on("board-update", (data) => console.log(data));

    setSocket(socketInstance);

    return () => {
      socketInstance.disconnect();
    };
  }, []);

  return (
    <div className="app">
      <main>
        {activeScreen === "home" && (
          <Home setActiveScreen={setActiveScreen} isConnected={isConnected} />
        )}
        {activeScreen === "play" && (
          <Play
            socket={socket}
            setActiveScreen={setActiveScreen}
            isConnected={isConnected}
          />
        )}
        {activeScreen === "puzzles" && (
          <Puzzles socket={socket} isConnected={isConnected} />
        )}
        {activeScreen === "scan" && (
          <Scan socket={socket} isConnected={isConnected} />
        )}
        {activeScreen === "profile" && <Profile />}
      </main>

      <Navbar activeScreen={activeScreen} setActiveScreen={setActiveScreen} />
    </div>
  );
}