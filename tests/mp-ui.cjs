// Browser E2E for the multiplayer game: two real Chrome tabs (Alice = host, Bob)
// against `wrangler dev`. Uses the real AI to score the drawings.
//
//   npm run build && npx wrangler dev --port 8787            (terminal 1)
//   chrome --headless=new --remote-debugging-port=9222 about:blank   (terminal 2)
//   node tests/mp-ui.cjs 8787 9222                           (~1.5 min: real 15s round timers)
const PORT = process.argv[2] || "8787";
const CDP = process.argv[3];
const APP = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (c, l) => { c ? (pass++, console.log("  PASS:", l)) : (fail++, console.log("  FAIL:", l)); };

// Keeps a handle on every WebSocket the page opens, so the test can drop a connection.
const CAPTURE = `(() => { const O = window.WebSocket; window.__sockets = [];
  function W(u, p) { const s = p ? new O(u, p) : new O(u); window.__sockets.push(s); return s; }
  W.prototype = O.prototype; W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3; window.WebSocket = W; })()`;

function rpc(ws, st, m, p = {}) {
  const id = st.id++;
  return new Promise((res, rej) => {
    const h = (e) => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener("message", h); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result); } };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id, method: m, params: p }));
  });
}

async function ctl(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  const st = { id: 1 };
  await rpc(ws, st, "Page.enable"); await rpc(ws, st, "Runtime.enable"); await rpc(ws, st, "Network.enable");
  await rpc(ws, st, "Network.setCacheDisabled", { cacheDisabled: true });
  await rpc(ws, st, "Emulation.setDeviceMetricsOverride", { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false });
  await rpc(ws, st, "Page.addScriptToEvaluateOnNewDocument", { source: CAPTURE });
  const ev = async (e) => {
    const r = await rpc(ws, st, "Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  };
  const q = JSON.stringify;
  const c = {
    ev,
    front: () => rpc(ws, st, "Page.bringToFront"),
    go: async (u) => { await rpc(ws, st, "Page.navigate", { url: u }); await sleep(1200); },
    vis: (s) => ev(`(() => { const e = document.querySelector(${q(s)}); if (!e) return false; const c = getComputedStyle(e); return e.getClientRects().length > 0 && c.display !== 'none' && c.visibility !== 'hidden'; })()`),
    click: (s) => ev(`document.querySelector(${q(s)}).click(); true`),
    text: (s) => ev(`document.querySelector(${q(s)}).textContent.trim()`),
    setv: (s, v) => ev(`(() => { const i = document.querySelector(${q(s)}); i.value = ${q(v)}; return true; })()`),
    waitFor: async (e, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return true; await sleep(150); } return false; },
    ink: () => ev(`(() => { const c = document.querySelector('#board'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let k = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) k++; return k; })()`),
    // Draw polylines (normalized coords) on #board with synthetic mouse events.
    draw: (strokes) => ev(`(() => { const cv = document.querySelector('#board'); const r = cv.getBoundingClientRect();
      const P = (u, v) => ({ clientX: r.left + u * r.width, clientY: r.top + v * r.height });
      const F = (t, p, g) => g.dispatchEvent(new MouseEvent(t, { clientX: p.clientX, clientY: p.clientY, bubbles: true }));
      for (const s of ${q(strokes)}) { F('mousedown', P(s[0][0], s[0][1]), cv); for (let i = 1; i < s.length; i++) F('mousemove', P(s[i][0], s[i][1]), cv); F('mouseup', P(0, 0), window); }
      return true; })()`),
    close: () => ws.close(),
  };
  return c;
}

// A ladder: two rails and rungs (the AI recognizes it reliably).
const LADDER = [[[0.32, 0.18], [0.32, 0.86]], [[0.62, 0.18], [0.62, 0.86]], ...Array.from({ length: 6 }, (_, i) => { const y = 0.24 + i * 0.12; return [[0.32, y], [0.62, y]]; })];

async function main() {
  const A = await ctl((await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((t) => t.type === "page").webSocketDebuggerUrl);
  await A.go(`${APP}/room`);
  await A.ev(`(async () => { if ('serviceWorker' in navigator) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); if (window.caches) for (const k of await caches.keys()) await caches.delete(k); localStorage.clear(); sessionStorage.clear(); return true; })()`);
  await A.go(`${APP}/room`);

  console.log("[1] Alice cria a sala; Bob entra pelo convite");
  await A.setv("#name-input", "Alice");
  await A.click("#create-btn");
  assert(await A.waitFor(`!document.querySelector('#room').hidden && /conectado/.test(document.querySelector('#conn-state').textContent)`), "Alice na sala, conectada");
  const code = await A.text("#room-code");
  assert((await A.ev(`location.search`)) === `?room=${code}`, "URL da sala atualizada para o convite");
  const nt = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const B = await ctl(nt.webSocketDebuggerUrl);
  await B.go(`${APP}/room?room=${code}`);
  await B.setv("#name-input", "Bob");
  await B.click("#invite-join-btn");
  assert(await B.waitFor(`!document.querySelector('#room').hidden && /conectado/.test(document.querySelector('#conn-state').textContent)`), "Bob entrou pelo convite");
  assert(await A.waitFor(`document.querySelectorAll('#players .player').length === 2`) && await B.waitFor(`document.querySelectorAll('#players .player').length === 2`), "os dois veem 2 jogadores");

  console.log("[2] Lobby: papéis, aquecimento compartilhado");
  assert(await A.vis("#host-panel") && !(await A.vis("#guest-note")), "anfitriã vê o painel de iniciar");
  assert(!(await B.vis("#host-panel")) && await B.vis("#guest-note"), "Bob vê 'aguardando o anfitrião'");
  assert((await A.ev(`document.querySelector('#players .player--self .player__tag')?.textContent`)) === "anfitrião", "Alice marcada como anfitriã");
  assert(!(await A.ev(`document.querySelector('#start-btn').disabled`)), "iniciar liberado com 2 jogadores");
  await A.draw([[[0.2, 0.2], [0.8, 0.8]]]);
  assert(await B.waitFor(`(() => { const c = document.querySelector('#board'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) return true; return false; })()`, 4000), "aquecimento: o traço de Alice aparece para Bob");
  await A.click("#clear-btn");

  console.log("[3] Iniciar partida (3 desenhos, 15s)");
  await A.ev(`document.querySelector('input[name="mp-rounds"][value="3"]').click(); document.querySelector('input[name="mp-seconds"][value="15"]').click(); true`);
  await A.click("#start-btn");
  const concepts = [];
  for (let r = 0; r < 3; r++) {
    const rn = `Desenho ${r + 1}/3`;
    assert(await A.waitFor(`document.querySelector('#mp-round').textContent === ${JSON.stringify(rn)} && !document.querySelector('#play-bar').hidden`, 12000) &&
           await B.waitFor(`document.querySelector('#mp-round').textContent === ${JSON.stringify(rn)}`, 5000), `${rn} começa para os dois ao mesmo tempo`);
    const pa = await A.text("#mp-prompt"), pb = await B.text("#mp-prompt");
    concepts.push(pa);
    assert(pa === pb && pa !== "—", `mesmo conceito para todos: "${pa}"`);
    if (r === 0) {
      assert(!(await A.vis("#host-panel")) && await A.vis("#play-bar"), "painel do anfitrião some; barra do conceito aparece");
      await A.front(); // hidden tabs get their timers throttled by Chrome
      const t1 = parseInt(await A.text("#mp-time"), 10); await sleep(1300);
      const t2 = parseInt(await A.text("#mp-time"), 10);
      assert(t2 < t1, `cronômetro regressivo (${t1}s -> ${t2}s)`);
    }
    // Private drawing: what Alice draws must NOT show up for Bob.
    await A.draw(LADDER);
    if (r === 1) {
      await B.draw([[[0.2, 0.3], [0.5, 0.6], [0.8, 0.3]]]); // a stroke, then the connection drops
      const inkBefore = await B.ink();
      await B.ev(`window.__sockets[window.__sockets.length - 1].close(4001, 'test-drop'); true`);
      assert(await B.waitFor(`/reconectando/.test(document.querySelector('#conn-state').textContent)`, 3000), "Bob vê 'reconectando…'");
      assert(await B.waitFor(`/^conectado$/.test(document.querySelector('#conn-state').textContent)`, 8000), "Bob reconecta sozinho");
      assert(await B.waitFor(`document.querySelector('#mp-round').textContent === 'Desenho 2/3'`, 3000), "volta no mesmo desenho");
      assert((await B.ink()) === inkBefore && inkBefore > 0, `o desenho de Bob foi preservado (${inkBefore}px)`);
      assert(await B.ev(`/voltou para a partida/.test(document.querySelector('#chat-log').textContent)`), "aviso de volta à partida");
    } else if (r === 0) {
      await B.draw(LADDER);
      assert((await B.ink()) > 1000, "Bob desenha no próprio quadro");
    } // r === 2: Bob draws NOTHING (blank drawing must score 0)
    // Time up -> board locks and the drawing is sent
    assert(await A.waitFor(`document.querySelector('#board-frame').classList.contains('board-frame--locked')`, 20000), "fim do tempo: quadro travado");
    assert(await A.waitFor(`/Desenho enviado/.test(document.querySelector('#mp-note').textContent)`, 5000), "Alice vê 'Desenho enviado'");
    if (r === 0) {
      const ink = await A.ink();
      await A.draw([[[0.1, 0.1], [0.9, 0.9]]]);
      assert((await A.ink()) === ink, "depois do tempo o quadro não aceita traços");
    }
  }

  console.log("[4] Avaliação pela IA e resultado");
  assert(await A.waitFor(`!document.querySelector('#judging-view').hidden || !document.querySelector('#results-view').hidden`, 8000), "fase de avaliação (ou direto o resultado)");
  assert(await A.waitFor(`!document.querySelector('#results-view').hidden`, 30000) && await B.waitFor(`!document.querySelector('#results-view').hidden`, 10000), "resultado aparece para os dois");
  const table = JSON.parse(await A.ev(`JSON.stringify([...document.querySelectorAll('#results-table tr')].map(tr => [...tr.children].map(c => c.textContent.trim())))`));
  const rows = table.slice(1);
  console.log("    ranking:", JSON.stringify(rows));
  assert(rows.length === 2, "2 jogadores no ranking");
  const parsed = rows.map((r) => ({ name: r[1].replace(" (você)", ""), pcts: r.slice(2, 5).map((s) => parseInt(s, 10)), total: parseInt(r[5], 10), raw: r.slice(2, 5) }));
  assert(parsed.every((p) => p.raw.every((s) => /^\d+%$/.test(s)) && p.pcts.every((n) => n >= 0 && n <= 100)), "notas são porcentagens inteiras de 0 a 100");
  assert(parsed.every((p) => p.total === p.pcts.reduce((a, b) => a + b, 0)), "total = soma das notas");
  assert(parsed[0].total >= parsed[1].total, "ranking em ordem decrescente");
  const bob = parsed.find((p) => p.name === "Bob"), alice = parsed.find((p) => p.name === "Alice");
  assert(bob && bob.pcts[2] === 0, "desenho em branco de Bob (3º) vale 0%");
  const ladderIdx = concepts.findIndex((c) => c === "escada");
  if (ladderIdx >= 0) assert(alice.pcts[ladderIdx] >= 50, `conceito "escada" desenhado como escada: IA deu ${alice.pcts[ladderIdx]}% (≥50)`);
  else console.log(`    (conceitos sorteados: ${concepts.join(", ")} — nenhum é "escada": desenhar uma escada para eles deve dar ~0%, e deu ${alice.pcts})`);
  const titleA = await A.text("#results-title"), titleB = await B.text("#results-title");
  console.log(`    título (Alice): "${titleA}" | (Bob): "${titleB}"`);
  if (alice.total !== bob.total) {
    const aliceWins = alice.total > bob.total;
    assert(titleA === (aliceWins ? "Você venceu!" : "Bob venceu!") && titleB === (aliceWins ? "Alice venceu!" : "Você venceu!"), "vencedor coerente com os totais, em cada ponto de vista");
  } else assert(/Empate|Ninguém/.test(titleA), "empate/ninguém pontuou refletido no título");
  assert((await A.ev(`document.querySelectorAll('.results__row--win').length`)) >= (alice.total === bob.total && alice.total === 0 ? 0 : 1), "linha do vencedor destacada");
  const thumbs = await A.ev(`document.querySelectorAll('.gallery__thumb').length`);
  const empties = await A.ev(`document.querySelectorAll('.gallery__empty').length`);
  assert(thumbs === 5 && empties === 1, `galeria: 5 desenhos + 1 'sem desenho' (${thumbs}+${empties})`);
  assert(await A.ev(`[...document.querySelectorAll('.gallery__thumb')].every(c => { const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) return true; return false; })`), "todas as miniaturas têm traço (desenhos reproduzidos)");
  const norm = `document.querySelector('#results-table').textContent.replace(/\\(você\\)/g, '').replace(/\\s+/g, '')`;
  assert((await A.ev(norm)) === (await B.ev(norm)), "os dois veem a mesma tabela de notas");

  console.log("[5] Jogar de novo é do anfitrião");
  assert(await A.vis("#again-btn") && !(await B.vis("#again-btn")) && await B.vis("#again-note"), "só Alice tem 'Jogar de novo'; Bob vê o aviso");
  await A.click("#again-btn");
  assert(await A.waitFor(`!document.querySelector('#stage').hidden && !document.querySelector('#host-panel').hidden`, 5000), "Alice volta ao lobby com o painel");
  assert(await B.waitFor(`!document.querySelector('#stage').hidden && !document.querySelector('#guest-note').hidden`, 5000), "Bob volta ao lobby");
  assert((await A.ev(`document.querySelectorAll('#players .player').length`)) === 2, "os 2 jogadores continuam na sala");

  console.log("[6] Sair da sala");
  await B.click("#leave-btn");
  await sleep(1500);
  assert((await B.ev(`location.pathname + location.search`)) === "/room", "Bob volta para a tela inicial do multiplayer");
  assert(await A.waitFor(`document.querySelectorAll('#players .player').length === 1`, 5000), "Alice vê 1 jogador depois que Bob sai");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  A.close(); B.close();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("E2E ERROR:", e); process.exit(2); });
