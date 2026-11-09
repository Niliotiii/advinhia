// Server flow test for the simultaneous-drawing game (GameRoom Durable Object).
// Needs the Worker running locally: `npx wrangler dev --port 8787` (after `npm run build`),
// then: `node tests/game-flow.cjs 8787`. Takes ~1 min (the real 15s round timer is used).
const PORT = process.argv[2] || "8787";
const ROOM = "flow" + Date.now();
const URL = `ws://localhost:${PORT}/room/${ROOM}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (c, l) => { c ? (pass++, console.log("  PASS:", l)) : (fail++, console.log("  FAIL:", l)); };
const uuid = () => crypto.randomUUID();

class Client {
  constructor(name, token) { this.name = name; this.token = token; this.inbox = []; this.waiters = []; this.closed = false; }
  async connect() {
    this.ws = new WebSocket(URL);
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; });
    });
    this.ws.addEventListener("close", () => (this.closed = true));
    await new Promise((res, rej) => { this.ws.addEventListener("open", res); this.ws.addEventListener("error", () => rej(new Error("ws error"))); });
    this.send({ t: "join", name: this.name, token: this.token });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  // Resolves with the first message (already received or future) that matches.
  wait(pred, ms = 8000, from = 0) {
    const hit = this.inbox.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error("timeout waiting for message")); }, ms);
    });
  }
  mark() { return this.inbox.length; }
  last(t) { return [...this.inbox].reverse().find((m) => m.t === t); }
}
const is = (t, extra = () => true) => (m) => m.t === t && extra(m);
const pts = (n) => Array.from({ length: n }, (_, i) => [i / n, 0.5, i === 0 ? 1 : 0]);

async function main() {
  const tA = uuid(), tB = uuid();
  const A = new Client("Alice", tA);
  await A.connect();
  const wa = await A.wait(is("welcome"));

  console.log("[1] Lobby: anfitrião, permissões e validações");
  assert(wa.hostId === wa.selfId, "primeiro a entrar é o anfitrião");
  assert(wa.phase === "lobby" && typeof wa.token === "string", "welcome traz fase e token");
  let m0 = A.mark();
  A.send({ t: "start", rounds: 3, seconds: 15 });
  const e1 = await A.wait(is("error"), 3000, m0);
  assert(e1.code === "not_enough_players", `1 jogador não inicia (${e1.code})`);

  const B = new Client("Bob", tB);
  await B.connect();
  const wb = await B.wait(is("welcome"));
  await A.wait(is("presence", (m) => m.players.length === 2));
  assert(wb.hostId === wa.selfId, "Bob vê Alice como anfitriã");
  m0 = B.mark();
  B.send({ t: "start", rounds: 3, seconds: 15 });
  assert((await B.wait(is("error"), 3000, m0)).code === "not_host", "não-anfitrião não inicia");
  m0 = A.mark();
  A.send({ t: "start", rounds: 5, seconds: 15 });
  assert((await A.wait(is("error"), 3000, m0)).code === "bad_settings", "configuração inválida é recusada");

  console.log("[2] Início sincronizado");
  const ma = A.mark(), mb = B.mark();
  A.send({ t: "start", rounds: 3, seconds: 15 });
  const gsA = await A.wait(is("gameStart"), 3000, ma);
  const rsA = await A.wait(is("roundStart"), 3000, ma);
  const rsB = await B.wait(is("roundStart"), 3000, mb);
  assert(gsA.rounds === 3 && gsA.seconds === 15, "gameStart com 3 rodadas / 15s");
  assert(rsA.round === 0 && rsA.total === 3, "rodada 0 de 3");
  assert(rsA.prompt.label === rsB.prompt.label && rsA.endsAt === rsB.endsAt, `mesmo conceito e mesmo fim para todos (${rsA.prompt.pt})`);
  const dur = rsA.endsAt - rsA.serverNow;
  assert(dur > 14000 && dur <= 15100, `duração ≈ 15s (${dur}ms)`);

  console.log("[3] Partida em andamento fica fechada");
  const C = new Client("Carol", uuid());
  await C.connect();
  const eC = await C.wait(is("error"), 3000);
  assert(eC.code === "in_progress", "novo jogador é recusado (in_progress)");
  await sleep(300);
  assert(C.closed, "conexão recusada é fechada");

  console.log("[4] Rodada 0: desenhos chegam depois do fim do tempo");
  m0 = A.mark();
  A.send({ t: "drawing", round: 1, pts: pts(10) });
  assert((await A.wait(is("error"), 3000, m0)).code === "bad_phase", "desenho de rodada errada é recusado");
  const reA0 = await A.wait(is("roundEnd"), 18000, ma);
  await B.wait(is("roundEnd"), 3000, mb);
  assert(reA0.round === 0, "roundEnd da rodada 0 (alarme do servidor)");
  A.send({ t: "drawing", round: 0, pts: pts(30) });
  B.send({ t: "drawing", round: 0, pts: pts(25) });
  assert((await A.wait(is("drawingAck", (m) => m.round === 0), 3000)).round === 0, "Alice recebe ack");
  await B.wait(is("drawingAck", (m) => m.round === 0), 3000);
  m0 = A.mark();
  A.send({ t: "drawing", round: 0, pts: [["x", "y"]] });
  assert((await A.wait(is("error"), 3000, m0)).code === "bad_drawing", "pontos inválidos são recusados");

  console.log("[5] Rodada 1: Bob cai e volta pelo token");
  const rs1A = await A.wait(is("roundStart", (m) => m.round === 1), 6000, ma);
  assert(rs1A.round === 1, "rodada 1 começa após o intervalo");
  B.ws.close();
  await A.wait(is("presence", (m) => m.players.find((p) => p.name === "Bob" && p.connected === false)), 4000);
  assert(true, "Alice vê Bob como desconectado (continua na lista)");
  const B2 = new Client("Bob", tB);
  await B2.connect();
  const wb2 = await B2.wait(is("welcome"));
  assert(wb2.selfId === wb.selfId, "Bob volta com a MESMA identidade");
  const gs2 = await B2.wait(is("gameStart"), 3000);
  const rs1B = await B2.wait(is("roundStart"), 3000);
  assert(gs2.rounds === 3 && rs1B.round === 1 && rs1B.endsAt === rs1A.endsAt, "Bob volta sincronizado (mesma rodada e mesmo fim)");
  // Bob does NOT submit a drawing for round 1.
  const mA1 = A.mark();
  await A.wait(is("roundEnd", (m) => m.round === 1), 18000, mA1);
  A.send({ t: "drawing", round: 1, pts: pts(40) });
  await A.wait(is("drawingAck", (m) => m.round === 1), 3000);

  console.log("[6] Rodada 2 e avaliação");
  const mA2 = A.mark(), mB2 = B2.mark();
  await A.wait(is("roundStart", (m) => m.round === 2), 6000, mA2);
  await A.wait(is("roundEnd", (m) => m.round === 2), 18000, mA2);
  A.send({ t: "drawing", round: 2, pts: pts(35) });
  B2.send({ t: "drawing", round: 2, pts: pts(20) });
  await A.wait(is("drawingAck", (m) => m.round === 2), 3000);
  await B2.wait(is("drawingAck", (m) => m.round === 2), 3000);
  const jA = await A.wait(is("judging"), 6000, mA2);
  const jB = await B2.wait(is("judging"), 6000, mB2);
  assert(jA.rounds.length === 3 && jB.rounds.length === 3, "fase de avaliação com os 3 conceitos");
  assert(jA.deadline - jA.serverNow > 20000, "prazo de avaliação ≈ 25s");

  m0 = A.mark();
  A.send({ t: "scores", scores: [0.3, 0.2] });
  assert((await A.wait(is("error"), 3000, m0)).code === "bad_scores", "scores com tamanho errado são recusados");
  const tScores = Date.now();
  A.send({ t: "scores", scores: [0.304, 0.2, 0.5] });
  B2.send({ t: "scores", scores: [0.8, 0.9, 0.5] }); // round 1 had NO drawing -> must count as 0
  const resA = await A.wait(is("results"), 5000, mA2);
  const resB = await B2.wait(is("results"), 5000, mB2);
  assert(Date.now() - tScores < 3000, `resultado sai assim que todos reportam (${Date.now() - tScores}ms, sem esperar o timeout)`);
  const rA = resA.results.players.find((p) => p.name === "Alice");
  const rB = resA.results.players.find((p) => p.name === "Bob");
  assert(JSON.stringify(rA.scores) === "[30,20,50]" && rA.total === 100, `Alice: ${rA.scores} = ${rA.total}`);
  assert(JSON.stringify(rB.scores) === "[80,0,50]" && rB.total === 130, `Bob: ${rB.scores} = ${rB.total} (rodada sem desenho vale 0)`);
  assert(resA.results.winners.length === 1 && resA.results.winners[0] === rB.id, "Bob vence");
  assert(JSON.stringify(resB.results) === JSON.stringify(resA.results), "todos recebem o mesmo resultado");
  assert(resA.drawings.length === 5, `5 desenhos no resultado (${resA.drawings.length})`);
  assert(resA.drawings.every((d) => d.pts.every((p) => p.length === 3 && p[0] >= 0 && p[0] <= 1)), "desenhos normalizados");

  console.log("[7] Jogar de novo");
  m0 = B2.mark();
  B2.send({ t: "playAgain" });
  assert((await B2.wait(is("error"), 3000, m0)).code === "not_host", "não-anfitrião não reinicia");
  const mA3 = A.mark();
  A.send({ t: "playAgain" });
  await A.wait(is("lobby"), 3000, mA3);
  assert(true, "anfitriã volta ao lobby");
  const D = new Client("Dave", uuid());
  await D.connect();
  assert((await D.wait(is("welcome"))).phase === "lobby", "no lobby novos jogadores entram de novo");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  [A, B2, D].forEach((c) => c.ws.close());
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("ERR", e); process.exit(2); });
