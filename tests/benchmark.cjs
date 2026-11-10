// Accuracy benchmark on real human drawings from Google's Quick, Draw! dataset
// (CC BY 4.0). Each drawing is placed on the 420px board with a random size and
// position, rendered with the app's own code, and classified by the real model.
// It answers: how much does the way we show a drawing to the AI matter?
//
//   npx vite --port 5199 --strictPort                          (terminal 1, dev server)
//   chrome --headless=new --remote-debugging-port=9222 about:blank   (terminal 2)
//   node tests/benchmark.cjs 5199 9222 [drawings-per-category=40]    (needs internet, ~1-2 min)
//
// Exit code is non-zero if the default AI rendering (AI_STROKE_RATIO) does not beat
// the old fixed 14px brush by at least 15 points.
const PORT = process.argv[2] || "5199";
const CDP = process.argv[3];
const PER = parseInt(process.argv[4] || "40", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CATS = ["apple", "cat", "house", "tree", "sun", "star", "clock", "key", "umbrella", "fish",
  "airplane", "bicycle", "book", "car", "flower", "hat", "ladder", "mushroom", "pizza", "sailboat"];

function rpc(ws, st, m, p = {}) { const id = st.id++; return new Promise((res, rej) => { const h = (e) => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener("message", h); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result); } }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id, method: m, params: p })); }); }

async function loadDrawings() {
  const data = [];
  for (const c of CATS) {
    const r = await fetch(`https://storage.googleapis.com/quickdraw_dataset/full/simplified/${c}.ndjson`, { headers: { Range: "bytes=0-1800000" } });
    const lines = (await r.text()).split("\n").slice(0, -1); // the last line may be cut off
    let n = 0;
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (!o.recognized) continue; // keep the ones Google's own classifier recognized
      const pts = o.drawing.reduce((a, s) => a + s[0].length, 0);
      if (o.drawing.length > 8 || pts > 300 || pts < 8) continue;
      data.push({ label: c, drawing: o.drawing });
      if (++n >= PER) break;
    }
  }
  return data;
}

const PAGE_CODE = (DATA) => `(async () => {
  const DATA = ${JSON.stringify(DATA)};
  const { SketchRecognizer } = await import('/src/recognizer.ts');
  const { renderDrawing, renderForAI, AI_STROKE_RATIO } = await import('/src/drawing.ts');
  const rec = new SketchRecognizer(); await rec.load();
  let seed = 31337; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const cv = document.createElement('canvas'); cv.width = 420; cv.height = 420;
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const variants = [
    { id: 'pincel fixo 14px (como era)', draw: (p) => renderDrawing(cv, p, 14) },
    { id: 'pincel fixo 20px', draw: (p) => renderDrawing(cv, p, 20) },
    ...[0.04, 0.05, 0.06, 0.07, 0.08].map((k) => ({ id: 'proporcional ' + (k * 100).toFixed(0) + '% do desenho' + (k === AI_STROKE_RATIO ? '  <- padrão do app' : ''), k, draw: (p) => renderForAI(cv, p, k) })),
  ];
  const S = Object.fromEntries(variants.map((v) => [v.id, { all: [0, 0], S: [0, 0], M: [0, 0], L: [0, 0], cat: {} }]));
  const bucket = (s) => (s < 0.5 ? 'S' : s < 0.7 ? 'M' : 'L');
  for (const item of DATA) {
    const s = 0.3 + rnd() * 0.65, room = 420 - s * 420 - 30;
    const ox = 15 + rnd() * Math.max(0, room), oy = 15 + rnd() * Math.max(0, room), k = (s * 420) / 255;
    const pts = [];
    for (const [xs, ys] of item.drawing) for (let j = 0; j < xs.length; j++) pts.push([r4((ox + xs[j] * k) / 420), r4((oy + ys[j] * k) / 420), j === 0 ? 1 : 0]);
    for (const v of variants) {
      v.draw(pts); rec.reset();
      const top = rec.predict(cv, 1)[0];
      const hit = top && top.label === item.label ? 1 : 0;
      const c = S[v.id]; c.all[0]++; c.all[1] += hit; c[bucket(s)][0]++; c[bucket(s)][1] += hit;
      const cc = (c.cat[item.label] ??= [0, 0]); cc[0]++; cc[1] += hit;
    }
  }
  return JSON.stringify({ S, ids: variants.map((v) => v.id), n: DATA.length, def: variants.find((v) => v.k === AI_STROKE_RATIO).id });
})()`;

(async () => {
  const data = await loadDrawings();
  console.log(`${data.length} desenhos humanos reais (${CATS.length} categorias). Rodando o modelo...`);
  const tg = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(tg.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  const st = { id: 1 };
  await rpc(ws, st, "Page.enable"); await rpc(ws, st, "Runtime.enable");
  await rpc(ws, st, "Page.navigate", { url: `http://localhost:${PORT}/room` }); await sleep(2500);
  const r = await rpc(ws, st, "Runtime.evaluate", { expression: PAGE_CODE(data), awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) { console.error(JSON.stringify(r.exceptionDetails).slice(0, 800)); process.exit(2); }
  const o = JSON.parse(r.result.value);
  const pc = (c) => (c[0] ? ((100 * c[1]) / c[0]).toFixed(0) : "-").padStart(3) + "%";
  console.log("\nacerto top-1 entre as 345 classes".padEnd(46), "geral | pequeno  médio  grande");
  for (const id of o.ids) { const c = o.S[id]; console.log(id.padEnd(46), pc(c.all), " |", pc(c.S), "  ", pc(c.M), "  ", pc(c.L)); }
  const cats = Object.keys(o.S[o.def].cat).sort();
  console.log("\npor categoria — pincel fixo 14px -> padrão do app:");
  console.log("  " + cats.map((c) => c.padEnd(9) + pc(o.S[o.ids[0]].cat[c]) + " -> " + pc(o.S[o.def].cat[c])).join("\n  "));
  const base = o.S[o.ids[0]].all, def = o.S[o.def].all;
  const gain = (def[1] / def[0] - base[1] / base[0]) * 100;
  console.log(`\npadrão do app vs pincel fixo 14px: ${gain >= 0 ? "+" : ""}${gain.toFixed(0)} pontos`);
  process.exit(gain >= 15 ? 0 : 1);
})().catch((e) => { console.error("ERR", e.message); process.exit(2); });
