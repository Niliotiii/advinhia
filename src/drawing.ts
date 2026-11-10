import type { DPoint } from "./shared/protocol";

/**
 * Replay a submitted drawing onto a canvas: black strokes on white, exactly
 * like DrawingBoard paints them (a dot where a stroke starts, a line between
 * consecutive points of the same stroke).
 *
 * Used both to score a drawing with the AI (420px canvas, 14px brush — the
 * same conditions as the live board) and to render result thumbnails (pass a
 * proportionally smaller `lineWidth`).
 */
export function renderDrawing(canvas: HTMLCanvasElement, pts: DPoint[], lineWidth: number): void {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = "#111";
  ctx.fillStyle = "#111";

  let px = 0;
  let py = 0;
  let havePrev = false;
  for (const [nx, ny, penDown] of pts) {
    const x = nx * w;
    const y = ny * h;
    if (penDown || !havePrev) {
      ctx.beginPath();
      ctx.arc(x, y, lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    px = x;
    py = y;
    havePrev = true;
  }
}

/**
 * Stroke width, as a share of the drawing's longest side, used when showing a
 * drawing to the AI. The model was trained on strokes whose thickness is
 * proportional to the drawing; a fixed pixel width is too thin for big
 * drawings and a blob for small ones (see tests/benchmark.cjs).
 */
export const AI_STROKE_RATIO = 0.06;
/** Never thinner than this (px on a 420px board), so tiny drawings still leave ink. */
const MIN_AI_STROKE_PX = 2;

/**
 * Render a drawing the way the AI should see it: always black on white, with a
 * stroke width proportional to the drawing's size. The brush and colour the
 * player used are only cosmetic and have no effect on recognition.
 */
export function renderForAI(
  canvas: HTMLCanvasElement,
  pts: DPoint[],
  ratio: number = AI_STROKE_RATIO,
): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [nx, ny] of pts) {
    const x = nx * canvas.width;
    const y = ny * canvas.height;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const longest = pts.length > 0 ? Math.max(maxX - minX, maxY - minY) : 0;
  renderDrawing(canvas, pts, Math.max(MIN_AI_STROKE_PX, ratio * longest));
}
