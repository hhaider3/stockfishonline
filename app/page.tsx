"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";

type EngineMode = "move" | "analysis";
type EngineRequest = { mode: EngineMode; fen: string; cancelled: boolean };
type StoredMove = { from: Square; to: Square; promotion?: PieceSymbol };
type StoredGame = {
  playerColor?: Color;
  level?: number;
  analysisOn?: boolean;
  fen?: string;
  baseFen?: string;
  moves?: StoredMove[];
  flipped?: boolean;
};
type PendingPromotion = { from: Square; to: Square } | null;
type DragState = {
  from: Square;
  color: Color;
  type: PieceSymbol;
  x: number;
  y: number;
  size: number;
  fontSize: number;
};

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
const INITIAL_FEN = new Chess().fen();

function rebuildGame(baseFen: string, moves: StoredMove[], target = moves.length) {
  const game = new Chess(baseFen);
  for (let i = 0; i < Math.min(target, moves.length); i++) {
    game.move(moves[i]);
  }
  return game;
}

function storedMoves(game: Chess): StoredMove[] {
  return game.history({ verbose: true }).map(({ from, to, promotion }) => ({
    from,
    to,
    ...(promotion ? { promotion } : {}),
  }));
}

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
  const gameRef = useRef(new Chess(INITIAL_FEN));
  const baseFenRef = useRef(INITIAL_FEN);
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef<EngineRequest | null>(null);
  const pendingRequestRef = useRef<Omit<EngineRequest, "cancelled"> | null>(null);
  const queuedEngineMoveRef = useRef(false);
  const analysisOnRef = useRef(true);
  const playerColorRef = useRef<Color>("w");
  const levelRef = useRef(2);
  const startSearchRef = useRef<(mode: EngineMode, searchFen: string) => void>(() => {});
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [fen, setFen] = useState(INITIAL_FEN);
  const [selected, setSelected] = useState<Square | null>(null);
  const [activeSquare, setActiveSquare] = useState<Square>("e2");
  const [lastMove, setLastMove] = useState<{ from: Square; to: Square } | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [playerColor, setPlayerColor] = useState<Color>("w");
  const [level, setLevel] = useState(2);
  const [engineState, setEngineState] = useState("Loading engine…");
  const [searchMode, setSearchMode] = useState<EngineMode | null>(null);
  const [analysisOn, setAnalysisOn] = useState(true);
  const [evaluation, setEvaluation] = useState(0);
  const [mate, setMate] = useState<number | null>(null);
  const [bestMove, setBestMove] = useState("—");
  const [pv, setPv] = useState<string[]>([]);
  const [depth, setDepth] = useState<number | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [fenInput, setFenInput] = useState(INITIAL_FEN);
  const [showFenBox, setShowFenBox] = useState(false);
  const [viewPly, setViewPly] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragOver, setDragOver] = useState<Square | null>(null);
  const dragGhostRef = useRef<HTMLSpanElement | null>(null);
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
    setDrag(null);
    setDragOver(null);
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

  const stopSearch = useCallback(() => {
    pendingRequestRef.current = null;
    queuedEngineMoveRef.current = false;
    if (requestRef.current) {
      requestRef.current.cancelled = true;
      workerRef.current?.postMessage("stop");
    }
    setSearchMode(null);
  }, []);

  const startSearch = useCallback(
    (mode: EngineMode, searchFen: string) => {
      const worker = workerRef.current;
      if (!worker || engineState !== "Ready") {
        if (mode === "move") queuedEngineMoveRef.current = true;
        return;
      }

      if (requestRef.current) {
        requestRef.current.cancelled = true;
        pendingRequestRef.current = { mode, fen: searchFen };
        setSearchMode(mode);
        worker.postMessage("stop");
        return;
      }

      pendingRequestRef.current = null;
      requestRef.current = { mode, fen: searchFen, cancelled: false };
      setSearchMode(mode);
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
    playerColorRef.current = playerColor;
    levelRef.current = level;
    startSearchRef.current = startSearch;
  }, [analysisOn, level, playerColor, startSearch]);

  // persistence
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("stockfish-board-v2");
      if (!raw) return;
      const d = JSON.parse(raw) as StoredGame;
      if (d.playerColor === "w" || d.playerColor === "b") setPlayerColor(d.playerColor);
      if (typeof d.level === "number" && d.level >= 0 && d.level < LEVELS.length) setLevel(d.level);
      if (typeof d.analysisOn === "boolean") setAnalysisOn(d.analysisOn);
      if (typeof d.flipped === "boolean") setFlipped(d.flipped);

      let restored: Chess | null = null;
      let restoredBase = INITIAL_FEN;
      if (typeof d.baseFen === "string" && Array.isArray(d.moves)) {
        try {
          restored = rebuildGame(d.baseFen, d.moves);
          restoredBase = d.baseFen;
        } catch {}
      }
      if (!restored && typeof d.fen === "string") {
        try {
          restored = new Chess(d.fen);
          restoredBase = restored.fen();
        } catch {}
      }
      if (restored) {
        baseFenRef.current = restoredBase;
        gameRef.current = restored;
        setFen(restored.fen());
        setFenInput(restored.fen());
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "stockfish-board-v2",
        JSON.stringify({
          playerColor,
          level,
          analysisOn,
          flipped,
          fen,
          baseFen: baseFenRef.current,
          moves: storedMoves(gameRef.current),
        }),
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
        applyUciOptions(worker!, levelRef.current);
        worker!.postMessage("isready");
        return;
      }
      if (line === "readyok") {
        setEngineState("Ready");
        return;
      }

      const request = requestRef.current;
      if (!request) return;

      if (!request.cancelled && line.startsWith("info ") && line.includes(" score ")) {
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
      requestRef.current = null;
      let followUp = pendingRequestRef.current;
      pendingRequestRef.current = null;

      if (!request.cancelled) {
        setBestMove(uci === "(none)" ? "—" : uci);
      }

      if (!request.cancelled && request.mode === "move" && uci && uci !== "(none)" && gameRef.current.fen() === request.fen) {
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
            followUp = { mode: "analysis", fen: gameRef.current.fen() };
          }
        } catch {
          setEngineState("Engine move error");
        }
      }

      if (followUp) {
        setSearchMode(followUp.mode);
        window.setTimeout(() => startSearchRef.current(followUp.mode, followUp.fen), 0);
      } else {
        setSearchMode(null);
      }
    };

    const onError = () => {
      if (stopped) return;
      setEngineState("Engine failed to load");
      setSearchMode(null);
    };

    worker.onmessage = onMessage;
    worker.onerror = onError;
    worker.postMessage("uci");
    return () => {
      stopped = true;
      worker?.terminate();
      workerRef.current = null;
      requestRef.current = null;
      pendingRequestRef.current = null;
    };
  }, [syncGame, applyUciOptions]);

  useEffect(() => {
    if (engineState !== "Ready") return;
    if (requestRef.current || pendingRequestRef.current) return;
    if (queuedEngineMoveRef.current) {
      queuedEngineMoveRef.current = false;
      startSearch("move", gameRef.current.fen());
    } else if (!gameRef.current.isGameOver() && gameRef.current.turn() !== playerColorRef.current) {
      startSearch("move", gameRef.current.fen());
    } else if (analysisOnRef.current && !gameRef.current.isGameOver()) {
      startSearch("analysis", gameRef.current.fen());
    }
  }, [engineState, startSearch]);

  // re-apply UCI options when level changes while idle
  useEffect(() => {
    if (engineState !== "Ready" || searchMode !== null) return;
    const w = workerRef.current;
    if (w) applyUciOptions(w, level);
  }, [level, engineState, searchMode, applyUciOptions]);

  const displayFen = useMemo(() => {
    if (viewPly === null) return fen;
    try {
      const moves = storedMoves(gameRef.current);
      const target = Math.max(0, Math.min(viewPly, moves.length));
      return rebuildGame(baseFenRef.current, moves, target).fen();
    } catch {
      return fen;
    }
  }, [fen, viewPly]);

  const displayGame = useMemo(() => {
    if (viewPly === null) return gameRef.current;
    try {
      const moves = storedMoves(gameRef.current);
      const target = Math.max(0, Math.min(viewPly, moves.length));
      return rebuildGame(baseFenRef.current, moves, target);
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
          const moves = storedMoves(gameRef.current);
          const target = Math.max(0, Math.min(viewPly, moves.length));
          gameRef.current = rebuildGame(baseFenRef.current, moves, target);
        } catch {}
        setViewPly(null);
      }
      if (searchMode === "move" || gameRef.current.turn() !== playerColor || gameRef.current.isGameOver()) return false;
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
    [playerColor, searchMode, startSearch, syncGame, viewPly, showToast],
  );

  // Touch pointers are implicitly captured by the square where the drag began,
  // so pointer events can't be trusted to target the square under the finger.
  // Hit-test by coordinates against the board rect instead.
  const squareFromPoint = useCallback(
    (clientX: number, clientY: number): Square | null => {
      const board = boardRef.current;
      if (!board) return null;
      const rect = board.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
      const column = Math.min(7, Math.floor((x / rect.width) * 8));
      const row = Math.min(7, Math.floor((y / rect.height) * 8));
      return boardSquares[row * 8 + column] ?? null;
    },
    [boardSquares],
  );

  useEffect(() => {
    if (!drag) return;
    const endDrag = () => {
      setDrag(null);
      setDragOver(null);
    };
    const onMove = (event: PointerEvent) => {
      const ghost = dragGhostRef.current;
      if (ghost) {
        ghost.style.transform = `translate3d(${event.clientX - drag.size / 2}px, ${
          event.clientY - drag.size / 2
        }px, 0)`;
      }
      const square = squareFromPoint(event.clientX, event.clientY);
      setDragOver((prev) => (prev === square ? prev : square));
    };
    const onUp = (event: PointerEvent) => {
      const target = squareFromPoint(event.clientX, event.clientY);
      if (target && target !== drag.from) {
        const legal = displayGame.moves({ square: drag.from, verbose: true }).some((m) => m.to === target);
        if (legal) {
          if (isPromotionMove(displayGame, drag.from, target)) setPendingPromotion({ from: drag.from, to: target });
          else commitMove(drag.from, target);
        }
      }
      endDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [drag, commitMove, displayGame, squareFromPoint]);

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
    const activeIndex = boardSquares.indexOf(activeSquare);
    const row = Math.floor(activeIndex / 8);
    const column = activeIndex % 8;
    let nextRow = row;
    let nextColumn = column;
    if (e.key === "ArrowLeft") nextColumn = Math.max(0, column - 1);
    if (e.key === "ArrowRight") nextColumn = Math.min(7, column + 1);
    if (e.key === "ArrowUp") nextRow = Math.max(0, row - 1);
    if (e.key === "ArrowDown") nextRow = Math.min(7, row + 1);
    if (nextRow !== row || nextColumn !== column) {
      e.preventDefault();
      setActiveSquare(boardSquares[nextRow * 8 + nextColumn]);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSquare(activeSquare);
      return;
    }
    if (e.key === "Escape") setSelected(null);
  };

  const resetGame = () => {
    stopSearch();
    baseFenRef.current = INITIAL_FEN;
    gameRef.current = new Chess(INITIAL_FEN);
    setLastMove(null);
    setActiveSquare(playerColor === "w" ? "e2" : "e7");
    setEvaluation(0);
    setMate(null);
    setBestMove("—");
    setPv([]);
    setDepth(null);
    setPendingPromotion(null);
    syncGame();
    if (playerColor === "b") {
      window.setTimeout(() => startSearch("move", gameRef.current.fen()), 50);
    } else if (analysisOn) {
      window.setTimeout(() => startSearch("analysis", gameRef.current.fen()), 50);
    }
  };

  const undoTurn = () => {
    stopSearch();
    if (gameRef.current.history().length) gameRef.current.undo();
    if (gameRef.current.turn() !== playerColor && gameRef.current.history().length) gameRef.current.undo();
    setLastMove(null);
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
    analysisOnRef.current = next;
    setAnalysisOn(next);
    if (!next && searchMode === "analysis") stopSearch();
    if (next && searchMode === null && gameRef.current.turn() === playerColor && !gameRef.current.isGameOver()) {
      window.setTimeout(() => startSearch("analysis", gameRef.current.fen()), 50);
    }
  };

  const chooseColor = (color: Color) => {
    if (color === playerColor) return;
    stopSearch();
    baseFenRef.current = INITIAL_FEN;
    gameRef.current = new Chess(INITIAL_FEN);
    playerColorRef.current = color;
    setPlayerColor(color);
    setFlipped(color === "b");
    setActiveSquare(color === "w" ? "e2" : "e7");
    setLastMove(null);
    setEvaluation(0);
    setMate(null);
    setBestMove("—");
    setPv([]);
    setDepth(null);
    setPendingPromotion(null);
    syncGame();
    const mode: EngineMode = color === "b" ? "move" : "analysis";
    if (mode === "move" || analysisOnRef.current) {
      window.setTimeout(() => startSearchRef.current(mode, gameRef.current.fen()), 50);
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
      stopSearch();
      baseFenRef.current = c.fen();
      gameRef.current = c;
      setLastMove(null);
      setEvaluation(0);
      setMate(null);
      setBestMove("—");
      setPv([]);
      setDepth(null);
      setPendingPromotion(null);
      syncGame();
      if (!c.isGameOver()) {
        const mode: EngineMode = c.turn() === playerColor ? "analysis" : "move";
        if (mode === "move" || analysisOn) {
          window.setTimeout(() => startSearch(mode, c.fen()), 50);
        }
      }
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
            {searchMode === "move" && <div className="thinking-bars" aria-label="Stockfish is thinking"><i /><i /><i /></div>}
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
              aria-activedescendant={`sq-${activeSquare}`}
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
                const isKeyboardActive = activeSquare === square;
                const isDragOver = drag !== null && dragOver === square;
                const displayFile = index >= 56;
                const displayRank = index % 8 === 0;
                return (
                  <button
                    id={`sq-${square}`}
                    className={`square ${light ? "light" : "dark"} ${isSelected ? "selected" : ""} ${isLast ? "last" : ""} ${isCheck ? "check" : ""} ${isDragOver ? "drag-over" : ""} ${isKeyboardActive ? "keyboard-active" : ""}`}
                    key={square}
                    tabIndex={-1}
                    onClick={() => {
                      setActiveSquare(square);
                      handleSquare(square);
                    }}
                    onPointerDown={(event) => {
                      setActiveSquare(square);
                      if (!piece || piece.color !== playerColor) return;
                      setSelected(square);
                      if (displayGame.turn() !== playerColor || viewPly !== null || searchMode === "move") return;
                      const board = boardRef.current?.getBoundingClientRect();
                      const pieceEl = event.currentTarget.querySelector(".piece");
                      if (!board || !pieceEl) return;
                      const parsed = Number.parseFloat(getComputedStyle(pieceEl).fontSize);
                      setDrag({
                        from: square,
                        color: piece.color,
                        type: piece.type,
                        x: event.clientX,
                        y: event.clientY,
                        size: board.width / 8,
                        fontSize: Number.isFinite(parsed) ? parsed : board.width / 10,
                      });
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
                        className={`piece ${piece.color === "w" ? "white-piece" : "black-piece"} ${drag?.from === square ? "drag-origin" : ""}`}
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
              {drag &&
                createPortal(
                  <span
                    ref={dragGhostRef}
                    className={`piece drag-ghost ${drag.color === "w" ? "white-piece" : "black-piece"}`}
                    aria-hidden
                    style={{
                      width: drag.size,
                      height: drag.size,
                      fontSize: drag.fontSize,
                      transform: `translate3d(${drag.x - drag.size / 2}px, ${drag.y - drag.size / 2}px, 0)`,
                    }}
                  >
                    {PIECES[drag.color][drag.type]}
                  </span>,
                  document.body,
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
              <code>{pv.length ? pv.map(prettyMove).join("  ·  ") : analysisOn ? searchMode === "analysis" ? "Calculating…" : "Play a move to analyze" : "Analysis paused"}</code>
            </div>
          </div>

          <div className="moves-card">
            <div className="moves-title"><span>Moves</span><span>{history.length} ply {viewPly !== null ? `· viewing ${viewPly}` : ""}</span></div>
            <div className="history-nav">
              <button onClick={() => setViewPly(0)} disabled={history.length === 0 || viewPly === 0} title="Start">⏮</button>
              <button onClick={() => setViewPly((v) => Math.max(0, (v ?? history.length) - 1))} disabled={history.length === 0 || (viewPly ?? history.length) === 0} title="Previous">◀</button>
              <button onClick={() => setViewPly(null)} disabled={viewPly === null} title="Latest">●</button>
              <button onClick={() => setViewPly((v) => Math.min(history.length, (v ?? history.length) + 1))} disabled={history.length === 0 || (viewPly ?? history.length) >= history.length} title="Next">▶</button>
              <button onClick={() => setViewPly(history.length)} disabled={history.length === 0 || viewPly === history.length} title="End">⏭</button>
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
