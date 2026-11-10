// Server flow test for the simultaneous-drawing game (GameRoom Durable Object),
// with cross-verified scoring: 3 players, one of them (Carol) cheats.
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
}
const is = (t, extra = () => true) => (m) => m.t === t && extra(m);
const pts = (n) => Array.from({ length: n }, (_, i) => [i / n, 0.5, i === 0 ? 1 : 0]);

async function main() {
  const tA = uuid(), tB = uuid(), tC = uuid();
  const A = new Client("Alice", tA);
  await A.connect();
  const wa = await A.wait(is("welcome"));

  console.log("[1] Lobby: anfitrião, permissões e validações");
  assert(wa.hostId === wa.selfId, "primeiro a entrar é o anfitrião");
  assert(wa.phase === "lobby" && typeof wa.token === "string", "welcome traz fase e token");
  let m0 = A.mark();
  A.send({ t: "start", rounds: 3, seconds: 15 });
  assert((await A.wait(is("error"), 3000, m0)).code === "not_enough_players", "1 jogador não inicia");

  const B = new Client("Bob", tB);
  await B.connect();
  const wb = await B.wait(is("welcome"));
  const C = new Client("Carol", tC);
  await C.connect();
  const wc = await C.wait(is("welcome"));
  await A.wait(is("presence", (m) => m.players.length === 3));
  assert(wb.hostId === wa.selfId, "Bob vê Alice como anfitriã");
  m0 = B.mark();
  B.send({ t: "start", rounds: 3, seconds: 15 });
  assert((await B.wait(is("error"), 3000, m0)).code === "not_host", "não-anfitrião não inicia");
  m0 = A.mark();
  A.send({ t: "start", rounds: 5, seconds: 15 });
  assert((await A.wait(is("error"), 3000, m0)).code === "bad_settings", "configuração inválida é recusada");

  console.log("[2] Início sincronizado");
  const ma = A.mark(), mb = B.mark(), mc = C.mark();
  A.send({ t: "start", rounds: 3, seconds: 15 });
  const gsA = await A.wait(is("gameStart"), 3000, ma);
  const rsA = await A.wait(is("roundStart"), 3000, ma);
  const rsB = await B.wait(is("roundStart"), 3000, mb);
  const rsC = await C.wait(is("roundStart"), 3000, mc);
  assert(gsA.rounds === 3 && gsA.seconds === 15, "gameStart com 3 rodadas / 15s");
  assert(rsA.round === 0 && rsA.total === 3, "rodada 0 de 3");
  assert(rsA.prompt.label === rsB.prompt.label && rsB.prompt.label === rsC.prompt.label && rsA.endsAt === rsC.endsAt, `mesmo conceito e mesmo fim para os 3 (${rsA.prompt.pt})`);
  const dur = rsA.endsAt - rsA.serverNow;
  assert(dur > 14000 && dur <= 15100, `duração ≈ 15s (${dur}ms)`);

  console.log("[3] Partida em andamento fica fechada");
  const D = new Client("Dave", uuid());
  await D.connect();
  assert((await D.wait(is("error"), 3000)).code === "in_progress", "novo jogador é recusado (in_progress)");
  await sleep(300);
  assert(D.closed, "conexão recusada é fechada");

  console.log("[4] Rodada 0: desenhos chegam depois do fim do tempo");
  m0 = A.mark();
  A.send({ t: "drawing", round: 1, pts: pts(10) });
  assert((await A.wait(is("error"), 3000, m0)).code === "bad_phase", "desenho de rodada errada é recusado");
  const reA0 = await A.wait(is("roundEnd"), 18000, ma);
  await B.wait(is("roundEnd"), 3000, mb);
  assert(reA0.round === 0, "roundEnd da rodada 0 (alarme do servidor)");
  A.send({ t: "drawing", round: 0, pts: pts(30) });
  B.send({ t: "drawing", round: 0, pts: pts(25) });
  C.send({ t: "drawing", round: 0, pts: pts(20) });
  await A.wait(is("drawingAck", (m) => m.round === 0), 3000);
  await B.wait(is("drawingAck", (m) => m.round === 0), 3000);
  await C.wait(is("drawingAck", (m) => m.round === 0), 3000);
  assert(true, "os 3 recebem ack");
  m0 = A.mark();
  A.send({ t: "drawing", round: 0, pts: [["x", "y"]] });
  assert((await A.wait(is("error"), 3000, m0)).code === "bad_drawing", "pontos inválidos são recusados");

  console.log("[5] Rodada 1: Bob cai e volta pelo token");
  const rs1A = await A.wait(is("roundStart", (m) => m.round === 1), 6000, ma);
  B.ws.close(1000);
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
  C.send({ t: "drawing", round: 1, pts: pts(15) });
  await A.wait(is("drawingAck", (m) => m.round === 1), 3000);

  console.log("[6] Rodada 2 e avaliação cruzada");
  const mA2 = A.mark(), mB2 = B2.mark(), mC2 = C.mark();
  await A.wait(is("roundStart", (m) => m.round === 2), 6000, mA2);
  await A.wait(is("roundEnd", (m) => m.round === 2), 18000, mA2);
  A.send({ t: "drawing", round: 2, pts: pts(35) });
  B2.send({ t: "drawing", round: 2, pts: pts(20) });
  C.send({ t: "drawing", round: 2, pts: pts(18) });
  await A.wait(is("drawingAck", (m) => m.round === 2), 3000);
  await B2.wait(is("drawingAck", (m) => m.round === 2), 3000);
  await C.wait(is("drawingAck", (m) => m.round === 2), 3000);
  const jA = await A.wait(is("judging"), 6000, mA2);
  const jB = await B2.wait(is("judging"), 6000, mB2);
  const jC = await C.wait(is("judging"), 6000, mC2);
  assert(jA.rounds.length === 3 && jB.rounds.length === 3, "fase de avaliação com os 3 conceitos");
  assert(jA.drawings.length === 8 && jB.drawings.length === 8 && jC.drawings.length === 8, `todos recebem os 8 desenhos para avaliar (${jA.drawings.length})`);
  const ids = { A: wa.selfId, B: wb.selfId, C: wc.selfId };
  assert(new Set(jA.drawings.map((d) => d.playerId)).size === 3, "desenhos dos 3 jogadores presentes");
  assert(jA.deadline - jA.serverNow > 20000, "prazo de avaliação ≈ 25s");

  m0 = A.mark();
  A.send({ t: "scores", scores: [0.3] }); // an array, not a map
  assert((await A.wait(is("error"), 3000, m0)).code === "bad_scores", "scores num formato inválido são recusados");

  // Honest evaluators (Alice, Bob) agree; Carol cheats: all-in for herself, zero for the others.
  const honest = {
    [ids.A]: [0.304, 0.2, 0.5],
    [ids.B]: [0.8, 0.9 /* no drawing in round 1: must still count as 0 */, 0.5],
    [ids.C]: [0.1, 0.1, 0.1],
  };
  const honestB = { ...honest, [ids.A]: [0.306, 0.2, 0.5] }; // tiny hardware-like difference
  const cheat = {
    [ids.A]: [0, 0, 0],
    [ids.B]: [0, 0, 0],
    [ids.C]: [1, 1, 1],
  };
  const tScores = Date.now();
  A.send({ t: "scores", scores: honest });
  B2.send({ t: "scores", scores: honestB });
  await sleep(400);
  assert(!A.inbox.slice(mA2).some((m) => m.t === "results"), "com 1 avaliador ainda pendente, o resultado espera");
  C.send({ t: "scores", scores: cheat });
  const resA = await A.wait(is("results"), 5000, mA2);
  const resB = await B2.wait(is("results"), 5000, mB2);
  assert(Date.now() - tScores < 3000, `resultado sai assim que todos reportam (${Date.now() - tScores}ms, sem esperar o timeout)`);
  const R = Object.fromEntries(resA.results.players.map((p) => [p.name, p]));
  assert(JSON.stringify(R.Alice.scores) === "[30,20,50]" && R.Alice.total === 100, `Alice: ${R.Alice.scores} = ${R.Alice.total} (a nota 0% da trapaceira foi ignorada)`);
  assert(JSON.stringify(R.Bob.scores) === "[80,0,50]" && R.Bob.total === 130, `Bob: ${R.Bob.scores} = ${R.Bob.total} (rodada sem desenho vale 0)`);
  assert(JSON.stringify(R.Carol.scores) === "[10,10,10]" && R.Carol.total === 30, `Carol: ${R.Carol.scores} = ${R.Carol.total} (os 100% que ela se deu foram ignorados)`);
  assert(JSON.stringify(R.Carol.disputed) === "[true,true,true]", "as notas de Carol aparecem como divergentes");
  assert(R.Bob.disputed[1] === false, "rodada sem desenho nunca é divergente");
  assert(resA.results.winners.length === 1 && resA.results.winners[0] === ids.B, "Bob vence, apesar da trapaça de Carol");
  assert(JSON.stringify(resB.results) === JSON.stringify(resA.results), "todos recebem o mesmo resultado");
  assert(resA.drawings.length === 8, `8 desenhos no resultado (${resA.drawings.length})`);
  assert(resA.drawings.every((d) => d.pts.every((p) => p.length === 3 && p[0] >= 0 && p[0] <= 1)), "desenhos normalizados");

  console.log("[7] Jogar de novo");
  m0 = B2.mark();
  B2.send({ t: "playAgain" });
  assert((await B2.wait(is("error"), 3000, m0)).code === "not_host", "não-anfitrião não reinicia");
  const mA3 = A.mark();
  A.send({ t: "playAgain" });
  await A.wait(is("lobby"), 3000, mA3);
  assert(true, "anfitriã volta ao lobby");
  const E = new Client("Eve", uuid());
  await E.connect();
  assert((await E.wait(is("welcome"))).phase === "lobby", "no lobby novos jogadores entram de novo");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  [A, B2, C, E].forEach((c) => c.ws.close(1000));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("ERR", e); process.exit(2); });
