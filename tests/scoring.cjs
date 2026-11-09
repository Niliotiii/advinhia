// Scoring pipeline test (multiplayer judging):
// draw on a real DrawingBoard, record points the way room.ts does, replay them with
// renderDrawing, and check recognizer.scoreFor gives the same answer for both.
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
  const { renderDrawing } = await import('/src/drawing.ts');
  const { SketchRecognizer } = await import('/src/recognizer.ts');
  const rec = new SketchRecognizer(); await rec.load();

  // The drawings: a ladder (two rails + rungs) and a lightning bolt — both real game concepts.
  const LADDER = [[[0.32,0.18],[0.32,0.86]], [[0.62,0.18],[0.62,0.86]], ...Array.from({length:6},(_,i)=>{const y=0.24+i*0.12;return [[0.32,y],[0.62,y]];})];
  const BOLT = [[[0.55,0.12],[0.38,0.5],[0.55,0.5],[0.4,0.88]]];
  const CIRCLE = BOLT;

  function drawLive(strokes) {
    const cv = document.createElement('canvas'); cv.width = 420; cv.height = 420;
    cv.style.cssText = 'position:fixed;left:0;top:0;width:420px;height:420px';
    document.body.appendChild(cv);
    const board = new DrawingBoard(cv); board.setBrushSize(14);
    const pts = []; // recorded exactly like room.ts record()
    const raw = []; // same points, unrounded (to isolate the effect of the rounding)
    board.setOnSegment((nx, ny, isStart) => {
      raw.push([nx, ny, isStart ? 1 : 0]);
      const x = Math.round(nx*10000)/10000, y = Math.round(ny*10000)/10000;
      if (!isStart) { const l = pts[pts.length-1]; if (l && l[0] === x && l[1] === y) return; }
      pts.push([x, y, isStart ? 1 : 0]);
    });
    const r = cv.getBoundingClientRect();
    const P = (u,v) => ({ clientX: r.left+u*r.width, clientY: r.top+v*r.height });
    const F = (t,p,g) => g.dispatchEvent(new MouseEvent(t, { clientX:p.clientX, clientY:p.clientY, bubbles:true }));
    for (const s of strokes) { F('mousedown', P(...s[0]), cv); for (let i=1;i<s.length;i++) F('mousemove', P(...s[i]), cv); F('mouseup', P(0,0), window); }
    return { cv, pts, raw };
  }
  function replay(pts) { const off = document.createElement('canvas'); off.width = 420; off.height = 420; renderDrawing(off, pts, 14); return off; }

  const out = {};
  const L = drawLive(LADDER), C = drawLive(CIRCLE);
  out.ladderPoints = L.pts.length;
  out.ladderLiveAsLadder = rec.scoreFor(L.cv, 'ladder');
  out.ladderReplayAsLadder = rec.scoreFor(replay(L.pts), 'ladder');
  out.ladderReplayAsCup = rec.scoreFor(replay(L.pts), 'cup');
  out.boltLive = rec.scoreFor(C.cv, 'lightning');
  out.boltReplayExact = rec.scoreFor(replay(C.raw), 'lightning');   // renderDrawing fidelity
  out.boltReplay = rec.scoreFor(replay(C.pts), 'lightning');        // what multiplayer scores (rounded points)
  out.ladderReplayExact = rec.scoreFor(replay(L.raw), 'ladder');
  out.boltReplayAsLadder = rec.scoreFor(replay(C.pts), 'ladder');
  // 40 wobbly hand-like drawings: the replay must stay within 2 points of the live canvas.
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const J = (v, a) => v + (rnd() - 0.5) * a;
  let worst = 0;
  for (let k = 0; k < 40; k++) {
    const strokes = k % 2 ? [[[J(.55,.06),J(.12,.04)],[J(.38,.06),J(.5,.04)],[J(.55,.06),J(.5,.04)],[J(.4,.06),J(.88,.04)]]]
      : [[[J(.32,.03),.18],[J(.32,.03),.86]], [[J(.62,.03),.18],[J(.62,.03),.86]], ...Array.from({length:6},(_,i)=>[[.32,J(.24+i*.12,.03)],[.62,J(.24+i*.12,.03)]])];
    const label = k % 2 ? 'lightning' : 'ladder';
    const D = drawLive(strokes);
    worst = Math.max(worst, Math.abs(rec.scoreFor(D.cv, label) - rec.scoreFor(replay(D.pts), label)));
    D.cv.remove();
  }
  out.worstDrift = worst;
  const blank = document.createElement('canvas'); blank.width = 420; blank.height = 420; renderDrawing(blank, [], 14);
  out.blank = rec.scoreFor(blank, 'ladder');
  out.unknownLabel = rec.scoreFor(replay(L.pts), 'not_a_class');
  // Scoring must not touch the live-guess smoothing history.
  rec.reset(); const before = rec.predict(L.cv, 3)[0].label; rec.scoreFor(replay(C.pts), 'lightning'); rec.reset();
  out.predictStillWorks = before;
  return JSON.stringify(out);
})()`;

(async () => {
  const tg = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(tg.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  const st = { id: 1 };
  await rpc(ws, st, "Page.enable"); await rpc(ws, st, "Runtime.enable");
  await rpc(ws, st, "Page.navigate", { url: `http://localhost:${PORT}/room` }); await sleep(2500);
  const r = await rpc(ws, st, "Runtime.evaluate", { expression: PAGE_CODE, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) { console.error("page error:", JSON.stringify(r.exceptionDetails).slice(0, 600)); process.exit(2); }
  const o = JSON.parse(r.result.value);
  const pct = (v) => (v * 100).toFixed(1) + "%";
  console.log("    ladder: live=" + pct(o.ladderLiveAsLadder) + " replay=" + pct(o.ladderReplayAsLadder) + " | as 'cup'=" + pct(o.ladderReplayAsCup) + " | points=" + o.ladderPoints);
  console.log("    raio (exato): replay=" + pct(o.boltReplayExact) + " | escada exata=" + pct(o.ladderReplayExact));
  console.log("    raio:   live=" + pct(o.boltLive) + " replay=" + pct(o.boltReplay) + " | as 'ladder'=" + pct(o.boltReplayAsLadder));
  assert(o.ladderLiveAsLadder > 0.8, `escada desenhada ao vivo é reconhecida como escada (${pct(o.ladderLiveAsLadder)})`);
  assert(o.ladderReplayAsLadder > 0.8, `a escada reproduzida a partir dos pontos gravados também (${pct(o.ladderReplayAsLadder)})`);
  assert(Math.abs(o.ladderLiveAsLadder - o.ladderReplayAsLadder) < 0.02, "escada: ao vivo e reproduzido dão a mesma nota (±2 pontos)");
  assert(Math.abs(o.boltLive - o.boltReplay) < 0.02, `raio: ao vivo ${pct(o.boltLive)} ≈ reproduzido ${pct(o.boltReplay)} (±2 pontos)`);
  assert(o.ladderReplayAsCup < 0.05, `escada contra o conceito errado ('xícara') dá nota baixa (${pct(o.ladderReplayAsCup)})`);
  assert(o.boltReplayAsLadder < 0.05, `raio contra 'escada' dá nota baixa (${pct(o.boltReplayAsLadder)})`);
  assert(o.worstDrift < 0.03, `40 desenhos tremidos: pior diferença entre ao vivo e reproduzido = ${(o.worstDrift * 100).toFixed(2)} pontos (<3)`);
  assert(o.blank === 0, "quadro em branco vale 0");
  assert(o.unknownLabel === 0, "rótulo desconhecido vale 0");
  assert(typeof o.predictStillWorks === "string", "scoreFor não interfere no palpite ao vivo (predict continua funcionando)");
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
