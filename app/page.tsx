"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";

type EngineMode = "move" | "analysis";
type EngineRequest = { mode: EngineMode; fen: string } | null;

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"] as const;
const PIECES: Record<Color, Record<PieceSymbol, string>> = {
  w: { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔" },
  b: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" },
};

const LEVELS = [
  { name: "Quick", time: 120 },
  { name: "Casual", time: 300 },
  { name: "Club", time: 650 },
  { name: "Expert", time: 1200 },
  { name: "Brutal", time: 2200 },
];

function prettyMove(move: string) {
  if (!move || move === "—") return "—";
  return `${move.slice(0, 2)} → ${move.slice(2, 4)}${move[4] ? ` = ${move[4].toUpperCase()}` : ""}`;
}

export default function Home() {
  const gameRef = useRef(new Chess());
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef<EngineRequest>(null);
  const queuedEngineMoveRef = useRef(false);
  const analysisOnRef = useRef(true);
  const startSearchRef = useRef<(mode: EngineMode, searchFen: string) => void>(() => {});
  const [fen, setFen] = useState(gameRef.current.fen());
  const [selected, setSelected] = useState<Square | null>(null);
  const [lastMove, setLastMove] = useState<{ from: Square; to: Square } | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [playerColor, setPlayerColor] = useState<Color>("w");
  const [level, setLevel] = useState(2);
  const [engineState, setEngineState] = useState("Loading engine…");
  const [thinking, setThinking] = useState(false);
  const [analysisOn, setAnalysisOn] = useState(true);
  const [evaluation, setEvaluation] = useState(0);
  const [mate, setMate] = useState<number | null>(null);
  const [bestMove, setBestMove] = useState("—");
  const [pv, setPv] = useState<string[]>([]);

  const syncGame = useCallback(() => {
    setFen(gameRef.current.fen());
    setSelected(null);
  }, []);

  const startSearch = useCallback((mode: EngineMode, searchFen: string) => {
    const worker = workerRef.current;
    if (!worker || engineState !== "Ready") {
      if (mode === "move") queuedEngineMoveRef.current = true;
      return;
    }
    worker.postMessage("stop");
    requestRef.current = { mode, fen: searchFen };
    setThinking(true);
    setBestMove("—");
    setPv([]);
    worker.postMessage(`position fen ${searchFen}`);
    if (mode === "move") {
      worker.postMessage(`go movetime ${LEVELS[level].time}`);
    } else {
      worker.postMessage("go depth 13");
    }
  }, [engineState, level]);

  useEffect(() => {
    analysisOnRef.current = analysisOn;
    startSearchRef.current = startSearch;
  }, [analysisOn, startSearch]);

  useEffect(() => {
    const worker = new Worker("/engine/stockfish.js");
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<string>) => {
      const line = String(event.data);
      if (line === "uciok") {
        worker.postMessage("isready");
        return;
      }
      if (line === "readyok") {
        setEngineState("Ready");
        return;
      }

      const request = requestRef.current;
      if (!request) return;

      if (line.startsWith("info ") && line.includes(" score ")) {
        const cp = line.match(/ score cp (-?\d+)/);
        const mateScore = line.match(/ score mate (-?\d+)/);
        const pvMatch = line.match(/\spv\s(.+)$/);
        const sideToMove = request.fen.split(" ")[1];
        const perspective = sideToMove === "w" ? 1 : -1;
        if (cp) {
          setEvaluation((Number(cp[1]) / 100) * perspective);
          setMate(null);
        } else if (mateScore) {
          setMate(Number(mateScore[1]) * perspective);
        }
        if (pvMatch) setPv(pvMatch[1].split(" ").slice(0, 5));
      }

      if (!line.startsWith("bestmove ")) return;
      const uci = line.split(" ")[1];
      setThinking(false);
      setBestMove(uci === "(none)" ? "—" : uci);
      requestRef.current = null;

      if (request.mode === "move" && uci && uci !== "(none)" && gameRef.current.fen() === request.fen) {
        try {
          const move = gameRef.current.move({
            from: uci.slice(0, 2) as Square,
            to: uci.slice(2, 4) as Square,
            promotion: (uci[4] || "q") as PieceSymbol,
          });
          setLastMove({ from: move.from, to: move.to });
          syncGame();
          if (analysisOnRef.current && !gameRef.current.isGameOver()) {
            window.setTimeout(() => startSearchRef.current("analysis", gameRef.current.fen()), 80);
          }
        } catch {
          setEngineState("Engine move error");
        }
      }
    };

    worker.onerror = () => {
      setEngineState("Engine failed to load");
      setThinking(false);
    };

    worker.postMessage("uci");
    return () => worker.terminate();
  }, [syncGame]);

  useEffect(() => {
    if (engineState !== "Ready") return;
    if (queuedEngineMoveRef.current) {
      queuedEngineMoveRef.current = false;
      startSearch("move", gameRef.current.fen());
    } else if (analysisOn && gameRef.current.history().length === 0) {
      startSearch("analysis", gameRef.current.fen());
    }
  }, [analysisOn, engineState, startSearch]);

  const legalTargets = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(
      gameRef.current.moves({ square: selected, verbose: true }).map((move) => move.to),
    );
  }, [selected, fen]);

  const boardSquares = useMemo(() => {
    const ranks = flipped ? [...RANKS].reverse() : [...RANKS];
    const files = flipped ? [...FILES].reverse() : [...FILES];
    return ranks.flatMap((rank) => files.map((file) => `${file}${rank}` as Square));
  }, [flipped]);

  const playMove = useCallback((from: Square, to: Square) => {
    if (thinking || gameRef.current.turn() !== playerColor || gameRef.current.isGameOver()) return;
    try {
      const move = gameRef.current.move({ from, to, promotion: "q" });
      setLastMove({ from: move.from, to: move.to });
      syncGame();
      if (!gameRef.current.isGameOver()) startSearch("move", gameRef.current.fen());
    } catch {
      setSelected(null);
    }
  }, [playerColor, startSearch, syncGame, thinking]);

  const handleSquare = (square: Square) => {
    if (selected && legalTargets.has(square)) {
      playMove(selected, square);
      return;
    }
    const piece = gameRef.current.get(square);
    setSelected(piece?.color === playerColor && gameRef.current.turn() === playerColor ? square : null);
  };

  const resetGame = () => {
    workerRef.current?.postMessage("stop");
    requestRef.current = null;
    gameRef.current.reset();
    setLastMove(null);
    setEvaluation(0);
    setMate(null);
    setBestMove("—");
    setPv([]);
    setThinking(false);
    syncGame();
    if (playerColor === "b") {
      window.setTimeout(() => startSearch("move", gameRef.current.fen()), 50);
    } else if (analysisOn) {
      window.setTimeout(() => startSearch("analysis", gameRef.current.fen()), 50);
    }
  };

  const undoTurn = () => {
    workerRef.current?.postMessage("stop");
    requestRef.current = null;
    if (gameRef.current.history().length) gameRef.current.undo();
    if (gameRef.current.turn() !== playerColor && gameRef.current.history().length) gameRef.current.undo();
    setLastMove(null);
    setThinking(false);
    syncGame();
    if (gameRef.current.turn() !== playerColor) {
      window.setTimeout(() => startSearch("move", gameRef.current.fen()), 50);
    } else if (analysisOn) {
      window.setTimeout(() => startSearch("analysis", gameRef.current.fen()), 50);
    }
  };

  const toggleAnalysis = () => {
    const next = !analysisOn;
    setAnalysisOn(next);
    workerRef.current?.postMessage("stop");
    requestRef.current = null;
    setThinking(false);
    if (next) window.setTimeout(() => startSearch("analysis", gameRef.current.fen()), 50);
  };

  const chooseColor = (color: Color) => {
    if (color === playerColor) return;
    workerRef.current?.postMessage("stop");
    requestRef.current = null;
    queuedEngineMoveRef.current = false;
    gameRef.current.reset();
    setPlayerColor(color);
    setFlipped(color === "b");
    setLastMove(null);
    setEvaluation(0);
    setMate(null);
    setBestMove("—");
    setPv([]);
    setThinking(false);
    syncGame();
    if (color === "b") {
      window.setTimeout(() => startSearchRef.current("move", gameRef.current.fen()), 50);
    } else if (analysisOnRef.current) {
      window.setTimeout(() => startSearchRef.current("analysis", gameRef.current.fen()), 50);
    }
  };

  const status = gameRef.current.isCheckmate()
    ? gameRef.current.turn() === playerColor ? "Checkmate · Stockfish wins" : "Checkmate · You win"
    : gameRef.current.isDraw()
      ? "Game drawn"
      : gameRef.current.isCheck()
        ? gameRef.current.turn() === playerColor ? "Your king is in check" : "Stockfish is in check"
        : gameRef.current.turn() === playerColor ? "Your move" : "Stockfish is thinking";

  const history = gameRef.current.history();
  const evalLabel = mate !== null
    ? `M${Math.abs(mate)}`
    : `${evaluation >= 0 ? "+" : ""}${evaluation.toFixed(1)}`;
  const evalPercent = mate !== null
    ? mate > 0 ? 94 : 6
    : Math.max(6, Math.min(94, 50 + evaluation * 7));

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#board" aria-label="Stockfish Board home">
          <span className="brand-mark">♞</span>
          <span>Stockfish <b>Board</b></span>
        </a>
        <div className="engine-pill" data-ready={engineState === "Ready"}>
          <span className="status-dot" />
          <span>{engineState === "Ready" ? "Stockfish 18 · Local" : engineState}</span>
        </div>
      </header>

      <section className="hero-copy">
        <p className="eyebrow">PLAY · LEARN · ANALYZE</p>
        <h1>Your board. <span>The engine&apos;s truth.</span></h1>
        <p>Play a full game against Stockfish, with private on-device analysis and no account required.</p>
      </section>

      <section className="game-layout" id="board">
        <div className="board-column">
          <div className="player-strip opponent">
            <div className={`avatar ${playerColor === "w" ? "dark" : "light-avatar"}`}>{playerColor === "w" ? "♞" : "♘"}</div>
            <div><strong>Stockfish</strong><span>{playerColor === "w" ? "Black" : "White"} · {LEVELS[level].name} strength</span></div>
            {thinking && <div className="thinking-bars" aria-label="Stockfish is thinking"><i /><i /><i /></div>}
          </div>

          <div className="board-wrap">
            <div className="eval-rail" aria-label={`Evaluation ${evalLabel}`}>
              <div className="eval-white" style={{ height: `${evalPercent}%` }} />
              <span>{evalLabel}</span>
            </div>
            <div className="chessboard" role="grid" aria-label="Chess board">
              {boardSquares.map((square, index) => {
                const piece = gameRef.current.get(square);
                const fileIndex = FILES.indexOf(square[0] as typeof FILES[number]);
                const rankIndex = Number(square[1]);
                const light = (fileIndex + rankIndex) % 2 === 1;
                const isSelected = selected === square;
                const isTarget = legalTargets.has(square);
                const isLast = lastMove?.from === square || lastMove?.to === square;
                const displayFile = index >= 56;
                const displayRank = index % 8 === 0;
                return (
                  <button
                    className={`square ${light ? "light" : "dark"} ${isSelected ? "selected" : ""} ${isLast ? "last" : ""}`}
                    key={square}
                    onClick={() => handleSquare(square)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const from = event.dataTransfer.getData("text/plain") as Square;
                      if (from) playMove(from, square);
                    }}
                    aria-label={`${square}${piece ? ` ${piece.color === "w" ? "white" : "black"} ${piece.type}` : " empty"}`}
                    role="gridcell"
                  >
                    {displayRank && <span className="rank-label">{square[1]}</span>}
                    {displayFile && <span className="file-label">{square[0]}</span>}
                    {isTarget && <span className={piece ? "capture-ring" : "move-dot"} />}
                    {piece && (
                      <span
                        className={`piece ${piece.color === "w" ? "white-piece" : "black-piece"}`}
                        draggable={piece.color === playerColor && gameRef.current.turn() === playerColor}
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/plain", square);
                          setSelected(square);
                        }}
                      >
                        {PIECES[piece.color][piece.type]}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="player-strip you">
            <div className={`avatar ${playerColor === "w" ? "light-avatar" : "dark"}`}>{playerColor === "w" ? "♙" : "♟"}</div>
            <div><strong>You</strong><span>{playerColor === "w" ? "White" : "Black"} pieces</span></div>
            <div className="turn-status">{status}</div>
          </div>
        </div>

        <aside className="control-panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">LIVE GAME</p>
              <h2>{status}</h2>
            </div>
            <button className="icon-button" onClick={() => setFlipped((value) => !value)} aria-label="Flip board" title="Flip board">⇅</button>
          </div>

          <div className="strength-block">
            <div className="side-picker">
              <span>Play as</span>
              <div className="segmented-control" role="group" aria-label="Choose your chess color">
                <button className={playerColor === "w" ? "active" : ""} onClick={() => chooseColor("w")} aria-pressed={playerColor === "w"}>○ White</button>
                <button className={playerColor === "b" ? "active" : ""} onClick={() => chooseColor("b")} aria-pressed={playerColor === "b"}>● Black</button>
              </div>
            </div>
            <div className="label-row"><label htmlFor="strength">Engine strength</label><strong>{LEVELS[level].name}</strong></div>
            <input id="strength" type="range" min="0" max="4" value={level} onChange={(event) => setLevel(Number(event.target.value))} />
            <div className="range-labels"><span>Quick</span><span>Brutal</span></div>
          </div>

          <div className="analysis-card">
            <div className="analysis-title">
              <div><span className="pulse-dot" /> Engine analysis</div>
              <button className={`toggle ${analysisOn ? "on" : ""}`} onClick={toggleAnalysis} aria-pressed={analysisOn} aria-label="Toggle analysis"><span /></button>
            </div>
            <div className="score-row">
              <div><span>Evaluation</span><strong>{evalLabel}</strong></div>
              <div><span>Best move</span><strong>{prettyMove(bestMove)}</strong></div>
            </div>
            <div className="line-box">
              <span>Principal variation</span>
              <code>{pv.length ? pv.map(prettyMove).join("  ·  ") : analysisOn ? thinking ? "Calculating…" : "Play a move to analyze" : "Analysis paused"}</code>
            </div>
          </div>

          <div className="moves-card">
            <div className="moves-title"><span>Moves</span><span>{history.length} ply</span></div>
            <div className="move-list">
              {history.length === 0 ? <p>{playerColor === "w" ? "No moves yet. You’re white." : "Stockfish is preparing the first move."}</p> : Array.from({ length: Math.ceil(history.length / 2) }, (_, index) => (
                <div className="move-row" key={index}>
                  <span>{index + 1}.</span><b>{history[index * 2]}</b><b>{history[index * 2 + 1] || ""}</b>
                </div>
              ))}
            </div>
          </div>

          <div className="actions">
            <button className="primary-button" onClick={resetGame}>New game</button>
            <button className="secondary-button" onClick={undoTurn} disabled={!history.length}>Undo turn</button>
          </div>
          <p className="privacy-note"><span>◈</span> Engine calculations stay on this device.</p>
        </aside>
      </section>

      <footer>
        <span>Powered by Stockfish 18 WebAssembly</span>
        <a href="https://github.com/official-stockfish/Stockfish" target="_blank" rel="noreferrer">Open-source engine</a>
        <a href="/engine/Copying.txt">GPLv3 license</a>
      </footer>
    </main>
  );
}
