"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";

type EngineMode = "move" | "analysis";
type EngineRequest = { mode: EngineMode; fen: string } | null;
type PendingPromotion = { from: Square; to: Square } | null;

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"] as const;
const PIECES: Record<Color, Record<PieceSymbol, string>> = {
  w: { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔" },
  b: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" },
};

type Level = {
  name: string;
  time: number;
  skill: number;
  elo: number;
  depth?: number;
  limitStrength: boolean;
};

const LEVELS: Level[] = [
  { name: "Quick", time: 140, skill: 3, elo: 1350, limitStrength: true },
  { name: "Casual", time: 350, skill: 7, elo: 1550, limitStrength: true },
  { name: "Club", time: 700, skill: 11, elo: 1820, limitStrength: true },
  { name: "Expert", time: 1300, skill: 16, elo: 2150, limitStrength: true },
  { name: "Brutal", time: 2200, skill: 20, elo: 2850, limitStrength: false },
];

const PROMOTION_PIECES: PieceSymbol[] = ["q", "r", "b", "n"];

function prettyMove(move: string) {
  if (!move || move === "—") return "—";
  return `${move.slice(0, 2)} → ${move.slice(2, 4)}${move[4] ? ` = ${move[4].toUpperCase()}` : ""}`;
}

function isPromotionMove(game: Chess, from: Square, to: Square) {
  const piece = game.get(from);
  if (!piece || piece.type !== "p") return false;
  const targetRank = to[1];
  return (piece.color === "w" && targetRank === "8") || (piece.color === "b" && targetRank === "1");
}

export default function Home() {
  const gameRef = useRef(new Chess());
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef<EngineRequest>(null);
  const queuedEngineMoveRef = useRef(false);
  const analysisOnRef = useRef(true);
  const startSearchRef = useRef<(mode: EngineMode, searchFen: string) => void>(() => {});
  const boardRef = useRef<HTMLDivElement | null>(null);
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
  const [depth, setDepth] = useState<number | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [fenInput, setFenInput] = useState(gameRef.current.fen());
  const [showFenBox, setShowFenBox] = useState(false);
  const [viewPly, setViewPly] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<Square | null>(null);
  const [copyLabel, setCopyLabel] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2200);
  }, []);

  const syncGame = useCallback(() => {
    const f = gameRef.current.fen();
    setFen(f);
    setFenInput(f);
    setSelected(null);
    setDragFrom(null);
    // when not browsing, keep view at latest
    setViewPly(null);
  }, []);

  const applyUciOptions = useCallback((worker: Worker, lvl: number) => {
    const cfg = LEVELS[lvl];
    if (!cfg) return;
    worker.postMessage(`setoption name Skill Level value ${cfg.skill}`);
    worker.postMessage(`setoption name UCI_LimitStrength value ${cfg.limitStrength ? "true" : "false"}`);
    if (cfg.limitStrength) {
      worker.postMessage(`setoption name UCI_Elo value ${cfg.elo}`);
    }
  }, []);

  const startSearch = useCallback(
    (mode: EngineMode, searchFen: string) => {
      const worker = workerRef.current;
      if (!worker || engineState !== "Ready") {
        if (mode === "move") queuedEngineMoveRef.current = true;
        return;
      }
      worker.postMessage("stop");
      requestRef.current = { mode, fen: searchFen };
      setThinking(true);
      if (mode === "move") setDepth(null);
      setBestMove("—");
      if (mode === "analysis") setPv([]);
      // for move, apply strength options just before search
      if (mode === "move") applyUciOptions(worker, level);
      worker.postMessage(`position fen ${searchFen}`);
      if (mode === "move") {
        worker.postMessage(`go movetime ${LEVELS[level].time}`);
      } else {
        worker.postMessage("go depth 14");
      }
    },
    [engineState, level, applyUciOptions],
  );

  useEffect(() => {
    analysisOnRef.current = analysisOn;
    startSearchRef.current = startSearch;
  }, [analysisOn, startSearch]);

  // persistence
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("stockfish-board-v2");
      if (!raw) return;
      const d = JSON.parse(raw) as { playerColor?: Color; level?: number; analysisOn?: boolean; fen?: string; flipped?: boolean };
      if (d.playerColor === "w" || d.playerColor === "b") setPlayerColor(d.playerColor);
      if (typeof d.level === "number" && d.level >= 0 && d.level < LEVELS.length) setLevel(d.level);
      if (typeof d.analysisOn === "boolean") setAnalysisOn(d.analysisOn);
      if (typeof d.flipped === "boolean") setFlipped(d.flipped);
      if (typeof d.fen === "string" && d.fen.split(" ").length >= 4) {
        try {
          const c = new Chess(d.fen);
          gameRef.current = c;
          setFen(c.fen());
          setFenInput(c.fen());
        } catch {}
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "stockfish-board-v2",
        JSON.stringify({ playerColor, level, analysisOn, flipped, fen }),
      );
    } catch {}
  }, [playerColor, level, analysisOn, flipped, fen]);

  useEffect(() => {
    let stopped = false;
    let worker: Worker | null = null;
    try {
      worker = new Worker("/engine/stockfish.js");
    } catch {
      setEngineState("Engine failed to load");
      return;
    }
    workerRef.current = worker;

    const onMessage = (event: MessageEvent<string>) => {
      const line = String(event.data);
      if (line === "uciok") {
        // set default options once
        applyUciOptions(worker!, level);
        worker!.postMessage("isready");
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
        const depthMatch = line.match(/\sdepth\s(\d+)/);
        const sideToMove = request.fen.split(" ")[1];
        const perspective = sideToMove === "w" ? 1 : -1;
        if (depthMatch) setDepth(Number(depthMatch[1]));
        if (cp) {
          setEvaluation((Number(cp[1]) / 100) * perspective);
          setMate(null);
        } else if (mateScore) {
          setMate(Number(mateScore[1]) * perspective);
        }
        if (pvMatch) setPv(pvMatch[1].split(" ").slice(0, 6));
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
          setCopyLabel(null);
          syncGame();
          if (analysisOnRef.current && !gameRef.current.isGameOver()) {
            window.setTimeout(() => startSearchRef.current("analysis", gameRef.current.fen()), 80);
          }
        } catch {
          setEngineState("Engine move error");
        }
      }
    };

    const onError = () => {
      if (stopped) return;
      setEngineState("Engine failed to load");
      setThinking(false);
    };

    worker.onmessage = onMessage;
    worker.onerror = onError;
    worker.postMessage("uci");
    return () => {
      stopped = true;
      worker?.terminate();
      workerRef.current = null;
    };
  }, [syncGame, applyUciOptions, level]);

  useEffect(() => {
    if (engineState !== "Ready") return;
    if (queuedEngineMoveRef.current) {
      queuedEngineMoveRef.current = false;
      startSearch("move", gameRef.current.fen());
    } else if (analysisOn && gameRef.current.history().length === 0) {
      startSearch("analysis", gameRef.current.fen());
    }
  }, [analysisOn, engineState, startSearch]);

  // re-apply UCI options when level changes while idle
  useEffect(() => {
    if (engineState !== "Ready" || thinking) return;
    const w = workerRef.current;
    if (w) applyUciOptions(w, level);
  }, [level, engineState, thinking, applyUciOptions]);

  const displayFen = useMemo(() => {
    if (viewPly === null) return fen;
    try {
      const c = new Chess();
      const hist = gameRef.current.history({ verbose: true });
      // rebuild to ply
      const target = Math.max(0, Math.min(viewPly, hist.length));
      const fresh = new Chess();
      for (let i = 0; i < target; i++) fresh.move(hist[i]);
      return fresh.fen();
    } catch {
      return fen;
    }
  }, [fen, viewPly]);

  const displayGame = useMemo(() => {
    if (viewPly === null) return gameRef.current;
    try {
      const c = new Chess();
      const hist = gameRef.current.history({ verbose: true });
      const target = Math.max(0, Math.min(viewPly, hist.length));
      for (let i = 0; i < target; i++) c.move(hist[i]);
      return c;
    } catch {
      return gameRef.current;
    }
  }, [fen, viewPly]);

  const legalTargets = useMemo(() => {
    if (!selected) return new Set<string>();
    try {
      return new Set(
        displayGame.moves({ square: selected, verbose: true }).map((m) => m.to),
      );
    } catch {
      return new Set<string>();
    }
  }, [selected, displayFen]);

  const boardSquares = useMemo(() => {
    const ranks = flipped ? [...RANKS].reverse() : [...RANKS];
    const files = flipped ? [...FILES].reverse() : [...FILES];
    return ranks.flatMap((rank) => files.map((file) => `${file}${rank}` as Square));
  }, [flipped]);

  const kingInCheckSquare: Square | null = useMemo(() => {
    if (!displayGame.isCheck()) return null;
    const turn = displayGame.turn();
    const board = displayGame.board();
    for (const row of board) for (const sq of row) if (sq && sq.type === "k" && sq.color === turn) return sq.square;
    return null;
  }, [displayFen]);

  const commitMove = useCallback(
    (from: Square, to: Square, promotion: PieceSymbol = "q") => {
      // if browsing history, truncate to that ply first
      if (viewPly !== null) {
        try {
          const hist = gameRef.current.history({ verbose: true });
          const target = Math.max(0, Math.min(viewPly, hist.length));
          const fresh = new Chess();
          for (let i = 0; i < target; i++) fresh.move(hist[i]);
          gameRef.current = fresh;
        } catch {}
        setViewPly(null);
      }
      if (thinking || gameRef.current.turn() !== playerColor || gameRef.current.isGameOver()) return false;
      try {
        const move = gameRef.current.move({ from, to, promotion });
        setLastMove({ from: move.from, to: move.to });
        setCopyLabel(null);
        syncGame();
        if (!gameRef.current.isGameOver()) startSearch("move", gameRef.current.fen());
        return true;
      } catch {
        showToast("Illegal move");
        setSelected(null);
        return false;
      }
    },
    [playerColor, startSearch, syncGame, thinking, viewPly, showToast],
  );

  const playMove = useCallback(
    (from: Square, to: Square) => {
      if (isPromotionMove(gameRef.current, from, to)) {
        setPendingPromotion({ from, to });
        return;
      }
      commitMove(from, to, "q");
    },
    [commitMove],
  );

  const handlePromotionPick = (piece: PieceSymbol) => {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    setPendingPromotion(null);
    commitMove(from, to, piece);
  };

  const handleSquare = (square: Square) => {
    if (pendingPromotion) return;
    if (viewPly !== null && selected && legalTargets.has(square)) {
      playMove(selected, square);
      return;
    }
    if (selected && legalTargets.has(square)) {
      playMove(selected, square);
      return;
    }
    const piece = displayGame.get(square);
    const canSelect = piece?.color === playerColor && displayGame.turn() === playerColor && viewPly === null;
    // allow selecting while browsing only to view moves, not to play unless at latest handled above
    if (viewPly !== null) {
      // browsing: allow selecting own piece to see moves, but not to play unless we exit browse via playMove
      setSelected(piece ? square : null);
      return;
    }
    setSelected(piece && canSelect ? square : null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (pendingPromotion) {
      if (e.key === "Escape") setPendingPromotion(null);
      return;
    }
    if (!selected) {
      // select with arrow keys from last move or center
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        constsq: Square = (gameRef.current.history().length ? (lastMove?.to ?? "e2") : "e2") as Square;
        setSelected(sq);
      }
      return;
    }
    const fileIdx = FILES.indexOf(selected[0] as typeof FILES[number]);
    const rankIdx = RANKS.indexOf(selected[1] as typeof RANKS[number]);
    let nf = fileIdx, nr = rankIdx;
    if (e.key === "ArrowLeft") nf = Math.max(0, fileIdx - 1);
    if (e.key === "ArrowRight") nf = Math.min(7, fileIdx + 1);
    if (e.key === "ArrowUp") nr = Math.max(0, rankIdx - 1);
    if (e.key === "ArrowDown") nr = Math.min(7, rankIdx + 1);
    if (nf !== fileIdx || nr !== rankIdx) {
      e.preventDefault();
      const ns = `${FILES[nf]}${RANKS[nr]}` as Square;
      // if target is legal, move
      if (legalTargets.has(ns)) playMove(selected, ns);
      else setSelected(ns);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      // cycle: if already selected, try to keep; otherwise handled by handleSquare
    }
    if (e.key === "Escape") setSelected(null);
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
    setDepth(null);
    setThinking(false);
    setPendingPromotion(null);
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
    setPendingPromotion(null);
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
    setDepth(null);
    setThinking(false);
    setPendingPromotion(null);
    syncGame();
    if (color === "b") {
      window.setTimeout(() => startSearchRef.current("move", gameRef.current.fen()), 50);
    } else if (analysisOnRef.current) {
      window.setTimeout(() => startSearchRef.current("analysis", gameRef.current.fen()), 50);
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyLabel(label);
      showToast(`${label} copied`);
      window.setTimeout(() => setCopyLabel((c) => (c === label ? null : c)), 1500);
    } catch {
      showToast("Copy failed");
    }
  };

  const loadFen = () => {
    const fenStr = fenInput.trim();
    try {
      const c = new Chess(fenStr);
      workerRef.current?.postMessage("stop");
      requestRef.current = null;
      gameRef.current = c;
      setLastMove(null);
      setEvaluation(0);
      setMate(null);
      setBestMove("—");
      setPv([]);
      setDepth(null);
      setThinking(false);
      setPendingPromotion(null);
      syncGame();
      if (analysisOn) window.setTimeout(() => startSearch("analysis", c.fen()), 50);
      showToast("Position loaded");
    } catch {
      showToast("Invalid FEN");
    }
  };

  const status = displayGame.isCheckmate()
    ? displayGame.turn() === playerColor ? "Checkmate · Stockfish wins" : "Checkmate · You win"
    : displayGame.isDraw()
      ? displayGame.isStalemate() ? "Stalemate · Draw" : displayGame.isThreefoldRepetition() ? "Repetition · Draw" : "Game drawn"
      : displayGame.isCheck()
        ? displayGame.turn() === playerColor ? "Your king is in check" : "Stockfish is in check"
        : viewPly !== null ? `Viewing move ${viewPly} · Latest is ${gameRef.current.history().length} ply`
        : displayGame.turn() === playerColor ? "Your move" : "Stockfish is thinking";

  const history = gameRef.current.history();
  const evalLabel = mate !== null ? `M${Math.abs(mate)}` : `${evaluation >= 0 ? "+" : ""}${evaluation.toFixed(2)}`;
  const evalPercent = mate !== null ? (mate > 0 ? 94 : 6) : Math.max(6, Math.min(94, 50 + evaluation * 7));
  const evalColor = mate !== null ? (mate > 0 ? "positive" : "negative") : evaluation > 0.3 ? "positive" : evaluation < -0.3 ? "negative" : "equal";

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#board" aria-label="Stockfish Board home">
          <span className="brand-mark">♞</span>
          <span>Stockfish <b>Board</b></span>
        </a>
        <div className="engine-pill" data-ready={engineState === "Ready"} title={engineState}>
          <span className="status-dot" />
          <span>{engineState === "Ready" ? "Stockfish 18 · Local" : engineState}</span>
          {engineState !== "Ready" && engineState !== "Loading engine…" && (
            <button className="retry-button" onClick={() => window.location.reload()}>Retry</button>
          )}
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
            <div><strong>Stockfish</strong><span>{playerColor === "w" ? "Black" : "White"} · {LEVELS[level].name} strength · {LEVELS[level].elo} Elo</span></div>
            {thinking && <div className="thinking-bars" aria-label="Stockfish is thinking"><i /><i /><i /></div>}
          </div>

          <div className="board-wrap">
            <div className={`eval-rail ${evalColor}`} aria-label={`Evaluation ${evalLabel}`} title={`Evaluation ${evalLabel}${depth ? ` · depth ${depth}` : ""}`}>
              <div className="eval-white" style={{ height: `${evalPercent}%` }} />
              <span>{evalLabel}</span>
              {depth && <em className="eval-depth">d{depth}</em>}
            </div>
            <div
              className="chessboard"
              role="grid"
              aria-label="Chess board"
              ref={boardRef}
              tabIndex={0}
              onKeyDown={handleKeyDown}
              aria-activedescendant={selected ? `sq-${selected}` : undefined}
            >
              {boardSquares.map((square, index) => {
                const piece = displayGame.get(square);
                const fileIndex = FILES.indexOf(square[0] as typeof FILES[number]);
                const rankIndex = Number(square[1]);
                const light = (fileIndex + rankIndex) % 2 === 1;
                const isSelected = selected === square;
                const isTarget = legalTargets.has(square);
                const isLast = lastMove?.from === square || lastMove?.to === square;
                const isCheck = kingInCheckSquare === square;
                const displayFile = index >= 56;
                const displayRank = index % 8 === 0;
                return (
                  <button
                    id={`sq-${square}`}
                    className={`square ${light ? "light" : "dark"} ${isSelected ? "selected" : ""} ${isLast ? "last" : ""} ${isCheck ? "check" : ""}`}
                    key={square}
                    onClick={() => handleSquare(square)}
                    onPointerDown={() => {
                      if (!piece || piece.color !== playerColor) return;
                      setDragFrom(square);
                      setSelected(square);
                    }}
                    onPointerUp={() => {
                      if (dragFrom && dragFrom !== square) {
                        // pointer drag finish
                        if (legalTargets.has(square) || displayGame.moves({ square: dragFrom, verbose: true }).some((m) => m.to === square)) {
                          // re-evaluate promotion from dragFrom
                          if (isPromotionMove(displayGame, dragFrom, square)) {
                            setPendingPromotion({ from: dragFrom, to: square });
                          } else {
                            commitMove(dragFrom, square);
                          }
                        }
                      }
                      setDragFrom(null);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const from = event.dataTransfer.getData("text/plain") as Square;
                      if (from) {
                        if (isPromotionMove(displayGame, from, square)) setPendingPromotion({ from, to: square });
                        else commitMove(from, square);
                      }
                    }}
                    aria-label={`${square}${piece ? ` ${piece.color === "w" ? "white" : "black"} ${piece.type}` : " empty"}${isSelected ? " selected" : ""}${isCheck ? " check" : ""}`}
                    aria-selected={isSelected}
                    role="gridcell"
                  >
                    {displayRank && <span className="rank-label">{square[1]}</span>}
                    {displayFile && <span className="file-label">{square[0]}</span>}
                    {isTarget && <span className={piece ? "capture-ring" : "move-dot"} />}
                    {piece && (
                      <span
                        className={`piece ${piece.color === "w" ? "white-piece" : "black-piece"}`}
                        draggable={piece.color === playerColor && displayGame.turn() === playerColor && viewPly === null && !thinking}
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/plain", square);
                          event.dataTransfer.effectAllowed = "move";
                          setSelected(square);
                        }}
                      >
                        {PIECES[piece.color][piece.type]}
                      </span>
                    )}
                  </button>
                );
              })}
              {pendingPromotion && (
                <div className="promotion-overlay" role="dialog" aria-label="Choose promotion piece">
                  <div className="promotion-box">
                    <p>Promote to</p>
                    <div className="promotion-choices">
                      {PROMOTION_PIECES.map((p) => (
                        <button key={p} onClick={() => handlePromotionPick(p)} aria-label={`Promote to ${p}`}>
                          {PIECES[playerColor][p]}
                        </button>
                      ))}
                    </div>
                    <button className="promotion-cancel" onClick={() => setPendingPromotion(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="player-strip you">
            <div className={`avatar ${playerColor === "w" ? "light-avatar" : "dark"}`}>{playerColor === "w" ? "♙" : "♟"}</div>
            <div><strong>You</strong><span>{playerColor === "w" ? "White" : "Black"} pieces{viewPly !== null ? " · browsing" : ""}</span></div>
            <div className="turn-status" aria-live="polite">{status}</div>
          </div>

          <div className="board-actions">
            <button onClick={() => setShowFenBox((v) => !v)} className="link-button">{showFenBox ? "Hide FEN" : "FEN / PGN"}</button>
            <button onClick={() => copyText(displayFen, "FEN")} className="link-button">Copy FEN{copyLabel === "FEN" ? " ✓" : ""}</button>
            <button onClick={() => copyText(gameRef.current.pgn(), "PGN")} className="link-button">Copy PGN{copyLabel === "PGN" ? " ✓" : ""}</button>
          </div>
          {showFenBox && (
            <div className="fen-box">
              <label htmlFor="fen-input">FEN</label>
              <div className="fen-row">
                <input id="fen-input" value={fenInput} onChange={(e) => setFenInput(e.target.value)} spellCheck={false} />
                <button onClick={loadFen} className="secondary-button small">Load</button>
              </div>
              <p className="fen-help">Paste a FEN and load position. Uses current side to move.</p>
            </div>
          )}
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
            <div className="label-row"><label htmlFor="strength">Engine strength</label><strong>{LEVELS[level].name} · {LEVELS[level].elo}</strong></div>
            <input id="strength" type="range" min="0" max="4" value={level} onChange={(event) => setLevel(Number(event.target.value))} aria-valuetext={LEVELS[level].name} />
            <div className="range-labels"><span>Quick</span><span>Brutal</span></div>
            <p className="strength-help">Skill {LEVELS[level].skill}/20 · {LEVELS[level].limitStrength ? `Elo capped` : "Full strength"} · {LEVELS[level].time}ms</p>
          </div>

          <div className="analysis-card">
            <div className="analysis-title">
              <div><span className="pulse-dot" aria-hidden /> Engine analysis {depth ? `· depth ${depth}` : ""}</div>
              <button className={`toggle ${analysisOn ? "on" : ""}`} onClick={toggleAnalysis} aria-pressed={analysisOn} aria-label="Toggle analysis"><span /></button>
            </div>
            <div className="score-row">
              <div><span>Evaluation</span><strong>{evalLabel}</strong></div>
              <div><span>Best move</span><strong>{prettyMove(bestMove)}</strong></div>
            </div>
            <div className="line-box">
              <span>Principal variation {pv.length ? `· ${pv.length} moves` : ""}</span>
              <code>{pv.length ? pv.map(prettyMove).join("  ·  ") : analysisOn ? thinking ? "Calculating…" : "Play a move to analyze" : "Analysis paused"}</code>
            </div>
          </div>

          <div className="moves-card">
            <div className="moves-title"><span>Moves</span><span>{history.length} ply {viewPly !== null ? `· viewing ${viewPly}` : ""}</span></div>
            <div className="history-nav">
              <button onClick={() => setViewPly(0)} disabled={history.length === 0 || viewPly === 0} title="Start">⏮</button>
              <button onClick={() => setViewPly((v) => Math.max(0, (v ?? history.length) - 1))} disabled={history.length === 0 || (viewPly ?? history.length) === 0} title="Previous">◀</button>
              <button onClick={() => setViewPly(null)} disabled={viewPly === null} title="Latest">●</button>
              <button onClick={() => setViewPly((v) => Math.min(history.length, (v ?? history.length) + 1))} disabled={history.length === 0 || (viewPly ?? history.length) >= history.length} title="Next">▶</button>
              <button onClick={() => setViewPly(history.length)} disabled={viewPly === history.length} title="End">⏭</button>
            </div>
            <div className="move-list" role="list">
              {history.length === 0 ? <p>{playerColor === "w" ? "No moves yet. You’re white." : "Stockfish is preparing the first move."}</p> : Array.from({ length: Math.ceil(history.length / 2) }, (_, index) => {
                const ply1 = index * 2;
                const ply2 = index * 2 + 1;
                const active1 = viewPly !== null ? viewPly === ply1 + 1 : false;
                const active2 = viewPly !== null ? viewPly === ply2 + 1 : false;
                const atLatest1 = viewPly === null && ply1 === history.length - 1;
                const atLatest2 = viewPly === null && ply2 === history.length - 1;
                return (
                  <div className="move-row" key={index} role="listitem">
                    <span>{index + 1}.</span>
                    <button className={`move-cell ${active1 || atLatest1 ? "active" : ""}`} onClick={() => setViewPly(ply1 + 1)}>{history[ply1]}</button>
                    <button className={`move-cell ${active2 || atLatest2 ? "active" : ""} ${!history[ply2] ? "empty" : ""}`} onClick={() => history[ply2] && setViewPly(ply2 + 1)}>{history[ply2] || ""}</button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="actions">
            <button className="primary-button" onClick={resetGame}>New game</button>
            <button className="secondary-button" onClick={undoTurn} disabled={!history.length}>Undo turn</button>
          </div>
          <p className="privacy-note"><span>◈</span> Engine calculations stay on this device. {viewPly !== null && <><button className="link-button inline" onClick={() => setViewPly(null)}>Return to latest</button></>}</p>
        </aside>
      </section>

      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}

      <footer>
        <span>Powered by Stockfish 18 WebAssembly</span>
        <a href="https://github.com/official-stockfish/Stockfish" target="_blank" rel="noreferrer">Open-source engine</a>
        <a href="/engine/Copying.txt">GPLv3 license</a>
      </footer>
    </main>
  );
}
