// Mobile test: emulates a 390x844 touch device and plays a game against a bot.
// Checks real touch drawing, layout overflow and that key controls are reachable.
//
//   npm run build && npx wrangler dev --port 8787            (terminal 1)
//   chrome --headless=new --remote-debugging-port=9222 about:blank   (terminal 2)
//   node tests/mobile.cjs 8787 9222 [screenshot-dir]         (~1 min)
const PORT = process.argv[2] || "8787";
const CDP = process.argv[3];
const SHOTS = process.argv[4];
// A fresh room every run: rooms persist in the local Durable Object storage.
const ROOM = ("M" + Math.random().toString(36).slice(2, 6)).toUpperCase();
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (c, l) => { c ? (pass++, console.log("  PASS:", l)) : (fail++, console.log("  FAIL:", l)); };
function rpc(ws, st, m, p = {}) { const id = st.id++; return new Promise((res, rej) => { const h = (e) => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener("message", h); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result); } }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id, method: m, params: p })); }); }

(async () => {
  const tg = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(tg.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  const st = { id: 1 };
  await rpc(ws, st, "Page.enable"); await rpc(ws, st, "Runtime.enable"); await rpc(ws, st, "Network.enable");
  await rpc(ws, st, "Network.setCacheDisabled", { cacheDisabled: true });
  await rpc(ws, st, "Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await rpc(ws, st, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const ev = async (e) => { const r = await rpc(ws, st, "Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + (r.exceptionDetails.exception?.description || "")); return r.result?.value; };
  const shot = async (n) => { if (!SHOTS) return; const s = await rpc(ws, st, "Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${SHOTS}/m_${n}.png`, Buffer.from(s.data, "base64")); };
  const waitFor = async (e, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return true; await sleep(150); } return false; };
  const noHScroll = async (l) => { const o = await ev(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })`); assert(o.sw <= o.iw + 1, `${l}: sem rolagem horizontal (${o.sw}px em ${o.iw}px)`); };
  const rect = (s) => ev(`(() => { const r = document.querySelector(${JSON.stringify(s)}).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);

  // Real touch events through CDP.
  const touchStroke = async (pts) => {
    const r = await rect("#board");
    const P = ([u, v]) => ({ x: r.l + u * r.w, y: r.t + v * r.h });
    await rpc(ws, st, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [P(pts[0])] });
    for (let i = 1; i < pts.length; i++) await rpc(ws, st, "Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [P(pts[i])] });
    await rpc(ws, st, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };

  await rpc(ws, st, "Page.navigate", { url: `http://localhost:${PORT}/room?room=${ROOM}` }); await sleep(1500);
  await noHScroll("convite"); await shot("1_invite");
  await ev(`document.querySelector('#name-input').value = 'Celular'; document.querySelector('#invite-join-btn').click(); true`);
  await waitFor(`/conectado/.test(document.querySelector('#conn-state').textContent)`);

  // Bot opponent: sends a drawing after each round and abstains from judging.
  const bot = new WebSocket(`ws://localhost:${PORT}/room/${ROOM.toLowerCase()}`); await new Promise((r) => bot.addEventListener("open", r));
  bot.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "roundEnd") { const p = []; for (let i = 0; i < 40; i++) p.push([+(0.2 + i * 0.015).toFixed(4), +(0.3 + i * 0.01).toFixed(4), i === 0 ? 1 : 0]); bot.send(JSON.stringify({ t: "drawing", round: m.round, pts: p })); }
    if (m.t === "judging") bot.send(JSON.stringify({ t: "scores", scores: {} }));
  });
  bot.send(JSON.stringify({ t: "join", name: "Bot", token: crypto.randomUUID() })); await sleep(900);

  console.log("[1] Sala de espera");
  await noHScroll("sala de espera"); await shot("2_waiting");
  const bar = await rect(".room__bar"), leave = await rect("#leave-btn");
  assert(leave.r <= bar.r + 0.5 && leave.l >= bar.l, `botão 'Sair' dentro da barra da sala (direita ${Math.round(leave.r)} ≤ ${Math.round(bar.r)})`);
  const startBtn = await rect("#start-btn"), board = await rect("#board");
  assert(startBtn.t < board.t, `'Iniciar partida' vem ANTES do quadro (topo ${Math.round(startBtn.t)} < ${Math.round(board.t)})`);
  assert(startBtn.b < 844, `'Iniciar partida' aparece na primeira tela (base em ${Math.round(startBtn.b)}px de 844)`);
  assert(await ev(`[...document.querySelectorAll('#host-panel .btn, #host-panel .seg__item span')].every((e) => e.getBoundingClientRect().height >= 34)`), "botões do painel com altura de toque ≥ 34px");

  console.log("[2] Partida com toque");
  await ev(`document.querySelector('input[name="mp-rounds"][value="3"]').click(); document.querySelector('input[name="mp-seconds"][value="15"]').click(); document.querySelector('#start-btn').click(); true`);
  assert(await waitFor(`!document.querySelector('#play-bar').hidden`, 8000), "partida começa no celular");
  await sleep(400);
  const tl = await ev(`(() => { const hostR = document.querySelector('#tools').getBoundingClientRect(); const bs = [...document.querySelectorAll('#tools button')].map((b) => b.getBoundingClientRect()); return { n: bs.length, minW: Math.min(...bs.map((r) => r.width)), minH: Math.min(...bs.map((r) => r.height)), inside: bs.every((r) => r.left >= 0 && r.right <= 390), hostRight: hostR.right }; })()`);
  assert(tl.n === 14 && tl.inside, `as ferramentas (8 cores + 5 espessuras + desfazer) cabem na tela do celular (${tl.n} botões)`);
  assert(tl.minW >= 34 && tl.minH >= 34, `todos os botões das ferramentas têm alvo de toque ≥ 34px (menor: ${Math.round(tl.minW)}×${Math.round(tl.minH)})`);
  const b2 = await rect("#board");
  assert(b2.l >= 0 && b2.r <= 390 && b2.w > 250, `o quadro cabe na tela (${Math.round(b2.w)}px de largura)`);
  await touchStroke([[0.32, 0.18], [0.32, 0.86]]); await touchStroke([[0.62, 0.18], [0.62, 0.86]]);
  for (let i = 0; i < 5; i++) { const y = 0.28 + i * 0.12; await touchStroke([[0.32, y], [0.47, y], [0.62, y]]); }
  const ink = await ev(`(() => { const c = document.querySelector('#board'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) k++; return k; })()`);
  assert(ink > 3000, `o dedo desenha no quadro (${ink}px)`);
  await noHScroll("durante o desenho"); await shot("3_drawing");
  assert(await waitFor(`/Desenho enviado/.test(document.querySelector('#mp-note').textContent)`, 20000), "desenho feito com toque é enviado e confirmado pelo servidor");

  console.log("[3] Resultado");
  assert(await waitFor(`!document.querySelector('#results-view').hidden`, 70000), "resultado aparece");
  await sleep(500); await noHScroll("resultado"); await shot("4_results");
  const wrap = await rect(".results__table-wrap"), total = await ev(`(() => { const r = document.querySelector('.results__total').getBoundingClientRect(); return { l: r.left, r: r.right }; })()`);
  assert(total.r <= wrap.r + 0.5 && total.l >= wrap.l, `coluna Total visível sem rolar (direita ${Math.round(total.r)} ≤ ${Math.round(wrap.r)})`);
  const again = await rect("#again-btn");
  assert(again.t < 700, `'Jogar de novo' aparece sem precisar rolar até o fim (topo em ${Math.round(again.t)}px)`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
