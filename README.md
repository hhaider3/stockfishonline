# Stockfish Online

Play chess against **Stockfish 18** in your browser — with live evaluation, principal variation, and private on-device analysis. No account required.

**Live site:** [https://site-creator-vinext-starter.hasanhaider009.workers.dev/](https://site-creator-vinext-starter.hasanhaider009.workers.dev/)

## Features

- Full game against Stockfish with click or drag-and-drop moves
- Play as White or Black
- Five strength levels: Quick → Casual → Club → Expert → Brutal
- Live evaluation bar, best move, and principal variation
- Toggle analysis on/off
- Undo turn and new game
- Engine runs **entirely in your browser** via WebAssembly — positions never leave your device

## Stack

| Layer | Technology |
| --- | --- |
| UI | React 19, Next.js App Router APIs via [vinext](https://github.com/cloudflare/vinext) |
| Engine | Stockfish 18 compiled to WebAssembly (`public/engine/`) |
| Game rules | [chess.js](https://github.com/jhlywa/chess.js) |
| Hosting | Cloudflare Workers |
| Styling | Tailwind CSS 4 |

Stockfish is loaded as a Web Worker from `/engine/stockfish.js` and talks UCI over `postMessage`. Search strength is controlled with `go movetime` (play) and `go depth` (analysis).

## Quick start

**Requirements:** Node.js `>= 22.13.0`

```bash
npm install
npm run dev
```

Open the local URL printed by vinext (typically `http://localhost:5173`).

```bash
npm run build   # production build → dist/
npm start       # serve the production build locally
npm test        # build + smoke test rendered HTML
npm run lint    # ESLint
```

## Project layout

```
app/                 # UI (page, layout, styles, optional ChatGPT auth helpers)
public/engine/       # stockfish.js, stockfish.wasm, GPLv3 license text
worker/              # Cloudflare Worker entry (SSR + image optimization)
build/               # vinext / Sites Vite plugin
db/                  # optional Drizzle schema (unused by default)
examples/d1/         # optional D1 example
vite.config.ts       # vinext + Cloudflare plugin
```

## Deploy (Cloudflare Workers)

This project is set up for Cloudflare Workers via Wrangler and vinext:

```bash
npm run build
npx wrangler login
npx wrangler deploy --config dist/server/wrangler.json
```

Optional D1 / R2 bindings can be declared in `.openai/hosting.json`. They are disabled by default (`null`).

Current production deployment:

```
https://site-creator-vinext-starter.hasanhaider009.workers.dev/
```

## How the engine works

1. The client creates `new Worker("/engine/stockfish.js")`.
2. It sends UCI handshake: `uci` → `isready`.
3. Positions are set with `position fen …`.
4. Play uses timed searches (`go movetime …`); analysis uses a fixed depth.
5. The UI parses `info … score … pv …` and `bestmove` lines for the eval bar and move list.

Because search runs in the browser, hosting cost stays low: the Worker mainly serves HTML, JS, CSS, and the WASM binary.

## License

- **This web app** — see repository license terms for application code you add.
- **Stockfish engine** — [GNU General Public License v3](public/engine/Copying.txt). When you distribute the WASM/JS engine, you must keep the license and make the corresponding Stockfish source available.

Upstream engine: [official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish)

## Credits

- [Stockfish](https://stockfishchess.org/) — world-class open-source chess engine
- [chess.js](https://github.com/jhlywa/chess.js) — move generation and validation
- [vinext](https://github.com/cloudflare/vinext) — Next.js-compatible runtime on Cloudflare
- [Cloudflare Workers](https://workers.cloudflare.com/) — edge hosting
