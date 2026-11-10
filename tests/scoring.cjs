// Scoring pipeline test: what the AI is shown must not depend on how the player
// draws on screen (brush width or colour), and the recorded vector points must score like the raw input.
//
//   npx vite --port 5199 --strictPort                         (terminal 1, dev server)
//   chrome --headless=new --remote-debugging-port=9222 about:blank   (terminal 2)
//   node tests/scoring.cjs 5199 9222
const PORT = process.argv[2] || "5199";
const CDP = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (c, l) => { c ? (pass++, console.log("  PASS:", l)) : (fail++, console.log("  FAIL:", l)); };
function rpc(ws, st, m, p = {}) { const id = st.id++; return new Promise((res, rej) => { const h = (e) => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener("message", h); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result); } }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id, method: m, params: p })); }); }

const PAGE_CODE = `(async () => {
  const { DrawingBoard } = await import('/src/board.ts');
  const { renderForAI } = await import('/src/drawing.ts');
  const { SketchRecognizer } = await import('/src/recognizer.ts');
  const rec = new SketchRecognizer(); await rec.load();

  const LADDER = [[[0.32,0.18],[0.32,0.86]], [[0.62,0.18],[0.62,0.86]], ...Array.from({length:6},(_,i)=>{const y=0.24+i*0.12;return [[0.32,y],[0.62,y]];})];
  const BOLT = [[[0.55,0.12],[0.38,0.5],[0.55,0.5],[0.4,0.88]]];

  // Draw with a REAL DrawingBoard (synthetic mouse events). width/color are indices
  // into shared/style.ts: widths [6,10,14,20,28]px, colours [black,red,orange,yellow,...].
  function drawLive(strokes, widthIdx, colorIdx = 0) {
    const cv = document.createElement('canvas'); cv.width = 420; cv.height = 420;
    cv.style.cssText = 'position:fixed;left:0;top:0;width:420px;height:420px';
    document.body.appendChild(cv);
    const board = new DrawingBoard(cv); board.setStyle({ width: widthIdx, color: colorIdx });
    const raw = []; board.setOnSegment((nx, ny, s) => raw.push([nx, ny, s ? 1 : 0]));
    const r = cv.getBoundingClientRect();
    const P = (u,v) => ({ clientX: r.left+u*r.width, clientY: r.top+v*r.height });
    const F = (t,p,g) => g.dispatchEvent(new MouseEvent(t, { clientX:p.clientX, clientY:p.clientY, bubbles:true }));
    for (const s of strokes) { F('mousedown', P(...s[0]), cv); for (let i=1;i<s.length;i++) F('mousemove', P(...s[i]), cv); F('mouseup', P(0,0), window); }
    const pts = board.getStrokes().map((p) => p.slice());
    cv.remove();
    return { pts, raw };
  }
  const ai = document.createElement('canvas'); ai.width = 420; ai.height = 420;
  const score = (pts, label) => { renderForAI(ai, pts); return rec.scoreFor(ai, label); };

  const out = {};
  // 1) The player's brush must not change what the AI sees.
  // brush 6px / 14px / 28px, and colours black / yellow (lightest) / purple
  out.ladder = {}; for (const b of [0, 2, 4]) out.ladder['pincel ' + [6,10,14,20,28][b]] = score(drawLive(LADDER, b).pts, 'ladder');
  out.bolt = {};   for (const b of [0, 2, 4]) out.bolt['pincel ' + [6,10,14,20,28][b]]   = score(drawLive(BOLT, b).pts, 'lightning');
  out.ladderColor = {}; for (const c of [0, 3, 6]) out.ladderColor['cor ' + c] = score(drawLive(LADDER, 2, c).pts, 'ladder');
  const L = drawLive(LADDER, 2), B = drawLive(BOLT, 2);
  out.ladderAsCup = score(L.pts, 'cup'); out.boltAsLadder = score(B.pts, 'ladder');
  out.points = L.pts.length;
  renderForAI(ai, L.pts); rec.reset(); out.ladderTop = rec.predict(ai, 1)[0].label; rec.reset();

  // 2) 40 wobbly drawings: brush invariance + effect of rounding to 4 decimals.
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const J = (v, a) => v + (rnd() - 0.5) * a;
  let worstBrush = 0, worstRound = 0;
  for (let k = 0; k < 40; k++) {
    const strokes = k % 2 ? [[[J(.55,.06),J(.12,.04)],[J(.38,.06),J(.5,.04)],[J(.55,.06),J(.5,.04)],[J(.4,.06),J(.88,.04)]]]
      : [[[J(.32,.03),.18],[J(.32,.03),.86]], [[J(.62,.03),.18],[J(.62,.03),.86]], ...Array.from({length:6},(_,i)=>[[.32,J(.24+i*.12,.03)],[.62,J(.24+i*.12,.03)]])];
    const label = k % 2 ? 'lightning' : 'ladder';
    const thin = drawLive(strokes, 0, 0), thick = drawLive(strokes, 4, 3);   // thin black vs thickest yellow
    worstBrush = Math.max(worstBrush, Math.abs(score(thin.pts, label) - score(thick.pts, label)));
    worstRound = Math.max(worstRound, Math.abs(score(thin.pts, label) - score(thin.raw, label)));
  }
  out.worstBrush = worstBrush; out.worstRound = worstRound;

  // 3) Edge cases.
  const blank = document.createElement('canvas'); blank.width = 420; blank.height = 420;
  renderForAI(blank, []); out.blank = rec.scoreFor(blank, 'ladder');
  out.unknownLabel = score(L.pts, 'not_a_class');
  rec.reset(); const before = rec.predict(ai, 3)[0]; rec.scoreFor(ai, 'ladder'); rec.reset();
  out.predictStillWorks = !!before;
  return JSON.stringify(out);
})()`;

(async () => {
  const tg = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(tg.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  const st = { id: 1 };
  await rpc(ws, st, "Page.enable"); await rpc(ws, st, "Runtime.enable");
  await rpc(ws, st, "Page.navigate", { url: `http://localhost:${PORT}/room` }); await sleep(2500);
  const r = await rpc(ws, st, "Runtime.evaluate", { expression: PAGE_CODE, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) { console.error("page error:", JSON.stringify(r.exceptionDetails).slice(0, 700)); process.exit(2); }
  const o = JSON.parse(r.result.value);
  const pct = (v) => (v * 100).toFixed(1) + "%";
  const vals = (m) => Object.values(m).map(pct).join(" / ");
  console.log("    escada com pincel 6/14/28px:", vals(o.ladder), "| raio:", vals(o.bolt), "| escada preto/amarelo/roxo:", vals(o.ladderColor));
  const spread = (m) => Math.max(...Object.values(m)) - Math.min(...Object.values(m));
  assert(o.ladderTop === 'ladder', `a escada é o palpite principal da IA (${pct(o.ladder['pincel 14'])} para 'escada')`);
  assert(o.bolt['pincel 14'] > 0.6, `o raio é reconhecido com folga (${pct(o.bolt['pincel 14'])})`);
  assert(spread(o.ladder) < 0.005, `a escada tem a MESMA nota com pincel 6, 14 ou 28px (variação ${(spread(o.ladder) * 100).toFixed(2)} pontos)`);
  assert(spread(o.ladderColor) < 0.005, `e a MESMA nota em preto, amarelo ou roxo (variação ${(spread(o.ladderColor) * 100).toFixed(2)} pontos)`);
  assert(spread(o.bolt) < 0.005, `o raio também (variação ${(spread(o.bolt) * 100).toFixed(2)} pontos)`);
  assert(o.worstBrush < 0.005, `40 desenhos tremidos: pincel e cor nunca mudam a nota (pior caso ${(o.worstBrush * 100).toFixed(2)} pontos)`);
  assert(o.worstRound < 0.03, `arredondar os pontos a 4 casas muda a nota no máximo ${(o.worstRound * 100).toFixed(2)} pontos (<3)`);
  assert(o.ladderAsCup < 0.05, `escada contra o conceito errado ('xícara') dá nota baixa (${pct(o.ladderAsCup)})`);
  assert(o.boltAsLadder < 0.05, `raio contra 'escada' dá nota baixa (${pct(o.boltAsLadder)})`);
  assert(o.blank === 0, "quadro em branco vale 0");
  assert(o.unknownLabel === 0, "rótulo desconhecido vale 0");
  assert(o.predictStillWorks, "scoreFor não interfere no palpite ao vivo (predict continua funcionando)");
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
