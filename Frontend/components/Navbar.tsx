"use client";

import React from "react";
import Icon from "./Icon";

interface NavbarProps {
  activeScreen: string;
  setActiveScreen: (screen: string) => void;
}

export default function Navbar({ activeScreen, setActiveScreen }: NavbarProps) {
  return (
    <nav id="tabs" aria-label="Main">
      <button
        type="button"
        className={activeScreen === "home" ? "on" : ""}
        data-go="home"
        onClick={() => setActiveScreen("home")}
      >
        <Icon name="home" />
        Home
      </button>
      <button
        type="button"
        className={activeScreen === "play" ? "on" : ""}
        data-go="play"
        onClick={() => setActiveScreen("play")}
      >
        <Icon name="play" />
        Play
      </button>
      <button
        type="button"
        className={activeScreen === "puzzles" ? "on" : ""}
        data-go="drills"
        onClick={() => setActiveScreen("puzzles")}
      >
        <Icon name="drills" />
        Puzzles
      </button>
      <button
        type="button"
        className={activeScreen === "scan" ? "on" : ""}
        data-go="replays"
        onClick={() => setActiveScreen("scan")}
      >
        <Icon name="search" />
        Scan
      </button>
      <button
        type="button"
        className={activeScreen === "profile" ? "on" : ""}
        data-go="me"
        onClick={() => setActiveScreen("profile")}
      >
        <Icon name="user" />
        Profile
      </button>
    </nav>
  );
}