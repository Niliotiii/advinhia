// Multiplayer end-to-end test with POSITIVE scores: a bot fetches, for every concept
// the server draws, a real human drawing of it from Google's Quick, Draw! dataset and
// submits it. The host's browser (real UI + real model) then judges it, and the
// result screen must show real percentages for the bot.
//
//   npm run build && npx wrangler dev --port 8787            (terminal 1)
//   chrome --headless=new --remote-debugging-port=9222 about:blank   (terminal 2)
//   node tests/mp-score.cjs 8787 9222                        (~1 min, needs internet)
const PORT = process.argv[2] || "8787";
const CDP = process.argv[3];
const ROOM = ("S" + Math.random().toString(36).slice(2, 6)).toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (c, l) => { c ? (pass++, console.log("  PASS:", l)) : (fail++, console.log("  FAIL:", l)); };
function rpc(ws, st, m, p = {}) { const id = st.id++; return new Promise((res, rej) => { const h = (e) => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener("message", h); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result); } }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id, method: m, params: p })); }); }

// A real human drawing of `label`, scaled to fill 80% of the board, as [x, y, penDown] points.
async function humanDrawing(label) {
  const r = await fetch(`https://storage.googleapis.com/quickdraw_dataset/full/simplified/${encodeURIComponent(label.replace(/_/g, " "))}.ndjson`, { headers: { Range: "bytes=0-600000" } });
  const lines = (await r.text()).split("\n").slice(0, -1);
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const n = o.drawing.reduce((a, s) => a + s[0].length, 0);
    if (!o.recognized || n < 10 || n > 250 || o.drawing.length > 8) continue;
    const k = (0.8 * 420) / 255, off = 0.1 * 420, pts = [];
    for (const [xs, ys] of o.drawing) for (let j = 0; j < xs.length; j++) pts.push([+((off + xs[j] * k) / 420).toFixed(4), +((off + ys[j] * k) / 420).toFixed(4), j === 0 ? 1 : 0]);
    return pts;
  }
  return null;
}

(async () => {
  const tg = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(tg.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  const st = { id: 1 };
  await rpc(ws, st, "Page.enable"); await rpc(ws, st, "Runtime.enable"); await rpc(ws, st, "Network.enable");
  await rpc(ws, st, "Network.setCacheDisabled", { cacheDisabled: true });
  const ev = async (e) => { const r = await rpc(ws, st, "Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + (r.exceptionDetails.exception?.description || "")); return r.result?.value; };
  const waitFor = async (e, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return true; await sleep(150); } return false; };

  await rpc(ws, st, "Page.navigate", { url: `http://localhost:${PORT}/room?room=${ROOM}` }); await sleep(1500);
  await ev(`document.querySelector('#name-input').value = 'Anfitriã'; document.querySelector('#invite-join-btn').click(); true`);
  assert(await waitFor(`/conectado/.test(document.querySelector('#conn-state').textContent)`), "anfitriã conectada");

  // The bot: a real human drawing of whatever concept is drawn.
  const bot = new WebSocket(`ws://localhost:${PORT}/room/${ROOM.toLowerCase()}`); await new Promise((r) => bot.addEventListener("open", r));
  const sample = {}; const concepts = [];
  bot.addEventListener("message", async (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "roundStart") { concepts[m.round] = m.prompt; sample[m.round] = humanDrawing(m.prompt.label); }
    if (m.t === "roundEnd") { const pts = await sample[m.round]; if (pts) bot.send(JSON.stringify({ t: "drawing", round: m.round, pts })); }
    if (m.t === "judging") bot.send(JSON.stringify({ t: "scores", scores: {} })); // abstain: only the host's browser judges
  });
  bot.send(JSON.stringify({ t: "join", name: "Humano", token: crypto.randomUUID() })); await sleep(900);

  await ev(`document.querySelector('input[name="mp-rounds"][value="3"]').click(); document.querySelector('input[name="mp-seconds"][value="15"]').click(); document.querySelector('#start-btn').click(); true`);
  assert(await waitFor(`!document.querySelector('#play-bar').hidden`, 8000), "partida começa");
  assert(await waitFor(`!document.querySelector('#results-view').hidden`, 80000), "o resultado aparece");

  const rows = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#results-table tr')].slice(1).map(tr => [...tr.children].map(c => c.textContent.trim())))`));
  console.log("    conceitos:", concepts.map((c) => c.pt).join(", "));
  console.log("    ranking:", JSON.stringify(rows));
  const bots = rows.find((r) => r[1].startsWith("Humano")), host = rows.find((r) => r[1].startsWith("Anfitriã"));
  const botScores = bots.slice(3).map((s) => parseInt(s, 10)), botTotal = parseInt(bots[2], 10);
  assert(botTotal === botScores.reduce((a, b) => a + b, 0), "total = soma das notas");
  assert(botTotal > 0, `o robô, com desenhos humanos reais do conceito, recebe nota positiva da IA (total ${botTotal})`);
  assert(botScores.some((s) => s >= 40), `pelo menos um desenho passa de 40% (${botScores.join("%, ")}%)`);
  assert(parseInt(host[2], 10) === 0, "a anfitriã, que não desenhou nada, fica com 0");
  assert((await ev(`document.querySelector('#results-title').textContent`)) === "Humano venceu!", "o vencedor é quem desenhou o conceito");
  assert((await ev(`document.querySelectorAll('.gallery__thumb').length`)) === 3, "galeria mostra os 3 desenhos do robô");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
