// Load test: a full room of 8 players (bots over WebSocket), one drawing at the
// 4000-point cap, cross-verified scoring from every player, and a 9th player.
//   npm run build && npx wrangler dev --port 8787
//   node tests/load-8.cjs 8787           (~1 min: real 15s timers)
const PORT = process.argv[2] || "8787";
const ROOM = "load" + Date.now();
const URL = `ws://localhost:${PORT}/room/${ROOM}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (c, l) => { c ? (pass++, console.log("  PASS:", l)) : (fail++, console.log("  FAIL:", l)); };
const ROUNDS = 3;

class Bot {
  constructor(i) { this.i = i; this.name = "Bot" + i; this.token = crypto.randomUUID(); this.inbox = []; this.bytes = {}; this.closed = false; }
  async connect() {
    this.ws = new WebSocket(URL);
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      this.inbox.push(m);
      this.bytes[m.t] = Math.max(this.bytes[m.t] || 0, e.data.length);
      this.react(m);
    });
    this.ws.addEventListener("close", () => (this.closed = true));
    await new Promise((res, rej) => { this.ws.addEventListener("open", res); this.ws.addEventListener("error", () => rej(new Error("ws error"))); });
    this.ws.send(JSON.stringify({ t: "join", name: this.name, token: this.token }));
  }
  react(m) {
    if (m.t === "roundEnd") {
      // Bot 0 sends a drawing at the 4000-point cap; the others ~600 points.
      const n = this.i === 0 ? 4000 : 600;
      const pts = Array.from({ length: n }, (_, k) => [+(0.5 + 0.4 * Math.cos(k / 40)).toFixed(4), +(0.5 + 0.4 * Math.sin(k / 53)).toFixed(4), k % 400 === 0 ? 1 : 0]);
      this.ws.send(JSON.stringify({ t: "drawing", round: m.round, pts }));
    }
    if (m.t === "judging") {
      // Honest evaluator: ~20% for every drawing, with a small per-bot noise.
      const out = {};
      for (const d of m.drawings) (out[d.playerId] ??= Array(ROUNDS).fill(0))[d.round] = 0.2 + (this.i - 3.5) * 0.002;
      this.reportAt = Date.now();
      this.ws.send(JSON.stringify({ t: "scores", scores: out }));
    }
  }
  wait(pred, ms = 8000) {
    const hit = this.inbox.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => { const h = this.inbox.find(pred); if (h) { clearInterval(iv); res(h); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error("timeout")); } }, 50);
    });
  }
}
const is = (t, f = () => true) => (m) => m.t === t && f(m);

(async () => {
  console.log("[1] Sala cheia");
  const bots = Array.from({ length: 8 }, (_, i) => new Bot(i));
  for (const b of bots) { await b.connect(); await sleep(80); }
  await bots[0].wait(is("presence", (m) => m.players.length === 8), 5000);
  assert(true, "8 jogadores na sala");
  const ninth = new Bot(9);
  await ninth.connect();
  assert((await ninth.wait(is("error"), 3000)).code === "room_full", "o 9º jogador é recusado (room_full)");

  console.log("[2] Partida de 3 desenhos / 15s com 8 jogadores");
  const t0 = Date.now();
  bots[0].ws.send(JSON.stringify({ t: "start", rounds: 3, seconds: 15 }));
  const starts = await Promise.all(bots.map((b) => b.wait(is("roundStart"), 5000)));
  assert(starts.every((s) => s.prompt.label === starts[0].prompt.label && s.endsAt === starts[0].endsAt), "os 8 recebem o mesmo conceito e o mesmo fim");

  const judgings = await Promise.all(bots.map((b) => b.wait(is("judging"), 90000)));
  assert(judgings.every((j) => j.drawings.length === 24), `todos recebem os 24 desenhos para avaliar (${judgings[0].drawings.length})`);
  const heavy = judgings[0].drawings.filter((d) => d.pts.length === 4000);
  assert(heavy.length === ROUNDS, `desenhos de 4000 pontos (o limite) foram aceitos (${heavy.length})`);
  console.log(`    maior mensagem 'judging': ${(bots[0].bytes.judging / 1024).toFixed(0)} KB`);

  const results = await Promise.all(bots.map((b) => b.wait(is("results"), 10000)));
  const lastReport = Math.max(...bots.map((b) => b.reportAt));
  const lag = Date.now() - lastReport;
  assert(lag < 4000, `resultado chega logo depois do último relatório (${lag}ms, sem esperar o timeout de 25s)`);
  console.log(`    maior mensagem 'results': ${(bots[0].bytes.results / 1024).toFixed(0)} KB | partida inteira: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const same = results.every((r) => JSON.stringify(r.results) === JSON.stringify(results[0].results));
  assert(same, "os 8 recebem exatamente o mesmo resultado");
  const players = results[0].results.players;
  assert(players.length === 8 && players.every((p) => p.scores.length === 3), "8 jogadores x 3 notas");
  assert(players.every((p) => p.scores.every((s) => s >= 19 && s <= 21)), `mediana de 8 avaliadores ≈ 20% em todos (min ${Math.min(...players.flatMap((p) => p.scores))}, max ${Math.max(...players.flatMap((p) => p.scores))})`);
  assert(players.every((p) => p.disputed.every((d) => d === false)), "ruído pequeno de hardware não vira divergência");
  assert(results[0].drawings.length === 24, "24 desenhos no resultado");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  [...bots, ninth].forEach((b) => b.ws.close(1000));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
