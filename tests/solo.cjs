// Solo mode browser test: menu -> game -> live AI guesses, and proof that the
// player's brush does not change what the AI sees (the "AI vision" thumbnail).
//
//   npm run build && npx wrangler dev --port 8787            (terminal 1)
//   chrome --headless=new --remote-debugging-port=9222 about:blank   (terminal 2)
//   node tests/solo.cjs 8787 9222
// Against production instead (analytics requests are blocked so stats stay clean):
//   node tests/solo.cjs 0 9222 https://your-domain.example
const PORT = process.argv[2] || "8787";
const CDP = process.argv[3];
const BASE = (process.argv[4] || `http://localhost:${PORT}`).replace(/\/$/, "");
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
  await rpc(ws, st, "Network.setBlockedURLs", { urls: ["*umami*"] });
  const ev = async (e) => { const r = await rpc(ws, st, "Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + (r.exceptionDetails.exception?.description || "")); return r.result?.value; };
  const waitFor = async (e, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return true; await sleep(150); } return false; };
  const click = (s) => ev(`document.querySelector(${JSON.stringify(s)}).click(); true`);
  const text = (s) => ev(`document.querySelector(${JSON.stringify(s)}).textContent.trim()`);

  await rpc(ws, st, "Page.navigate", { url: `${BASE}/` }); await sleep(1000);
  await ev(`(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) await caches.delete(k); localStorage.clear(); return true; })()`);
  await rpc(ws, st, "Page.navigate", { url: `${BASE}/` }); await sleep(1000);

  console.log("[1] Menu e início");
  assert((await ev(`document.querySelector('#app').dataset.view`)) === "menu", "abre no menu");
  assert(await waitFor(`!document.querySelector('#play-solo-btn').disabled`), "o modelo carrega e libera o solo");

  // Draw the same ladder in a fresh solo game with a given brush; return the AI-vision pixels + board ink.
  async function playWithBrush(brush) {
    await click("#settings-toggle");
    await ev(`document.querySelector('input[name="brush"][value="${brush}"]').click(); true`);
    await click("#settings-toggle");
    await click("#play-solo-btn");
    if (!(await waitFor(`document.querySelector('#prompt').textContent !== '—'`, 5000))) throw new Error("partida não iniciou");
    await ev(`(() => { const c = document.querySelector('#board'); const r = c.getBoundingClientRect();
      const P = (u, v) => ({ clientX: r.left + u * r.width, clientY: r.top + v * r.height });
      const F = (t, p, g) => g.dispatchEvent(new MouseEvent(t, { clientX: p.clientX, clientY: p.clientY, bubbles: true }));
      const S = [[[.32,.18],[.32,.86]], [[.62,.18],[.62,.86]], ...Array.from({ length: 6 }, (_, i) => [[.32, .24 + i * .12], [.62, .24 + i * .12]])];
      for (const s of S) { F('mousedown', P(...s[0]), c); for (let i = 1; i < s.length; i++) F('mousemove', P(...s[i]), c); F('mouseup', P(0, 0), window); } return true; })()`);
    await waitFor(`document.querySelectorAll('#guesses .guess').length > 0`, 5000);
    await sleep(1200); // let the 250ms inference loop catch up with the finished drawing
    return ev(`(() => {
      const v = document.querySelector('#vision').getContext('2d').getImageData(0, 0, 28, 28).data;
      let sum = 0, vis = []; for (let i = 0; i < v.length; i += 4) { vis.push(v[i]); sum += v[i]; }
      const b = document.querySelector('#board'); const d = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
      let ink = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) ink++;
      const g = document.querySelector('#guesses .guess');
      return { vision: vis.join(','), visionSum: sum, ink, top: g.querySelector('.guess__label').textContent, pct: g.querySelector('.guess__pct').textContent };
    })()`);
  }

  console.log("[2] Mesma escada com pincel fino e com pincel grosso");
  const thin = await playWithBrush("thin");
  await click("#menu-btn");
  assert((await ev(`document.querySelector('#app').dataset.view`)) === "menu", "botão Menu volta ao menu");
  const thick = await playWithBrush("thick");
  console.log(`    pincel fino : traço na tela=${thin.ink}px | palpite: ${thin.top} ${thin.pct}`);
  console.log(`    pincel grosso: traço na tela=${thick.ink}px | palpite: ${thick.top} ${thick.pct}`);
  assert(thin.visionSum > 0 && thick.visionSum > 0, "a miniatura 'o que a IA enxerga' é preenchida");
  assert(thick.ink > thin.ink * 1.5, `o traço visível muda com o pincel (${thin.ink}px -> ${thick.ink}px)`);
  assert(thin.vision === thick.vision, "mas a entrada da IA (28x28) é IDÊNTICA pixel a pixel");
  assert(/ladder/i.test(thin.top) && /ladder/i.test(thick.top), "a escada é o palpite principal nos dois casos");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
