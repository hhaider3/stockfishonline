import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders Stockfish Board", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Stockfish Board.*<\/title>/i);
  assert.match(html, /Stockfish Board/);
  assert.match(html, /Your board/);
  assert.match(html, /Chess board/);
  assert.match(html, /Engine analysis/);
  assert.match(html, /Stockfish 18/);
});

test("client board has a11y and controls", async () => {
  const response = await render();
  const html = await response.text();
  // board with grid role and 64 squares
  assert.match(html, /role="grid"/);
  assert.match(html, /aria-label="Chess board"/);
  // controls
  assert.match(html, /Engine strength/);
  assert.match(html, /Play as/);
  assert.match(html, /FEN \/ PGN|Copy FEN/);
  // evaluation rail
  assert.match(html, /eval-rail/);
});
