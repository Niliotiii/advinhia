import type { DPoint } from "./shared/protocol";
import { BRUSH_WIDTHS, DEFAULT_COLOR, DEFAULT_WIDTH, PALETTE } from "./shared/style";

interface StrokeStyle {
  color: string;
  width: number;
}

/**
 * Paint a list of points onto a canvas (white background): a dot where a stroke
 * starts, a line between consecutive points of the same stroke. `styleOf` picks
 * the colour/width for every new stroke from the optional style indices that
 * pen-down points carry; the rest of the stroke inherits it.
 *
 * This is the single painter used by the live board (undo), the result
 * thumbnails and the AI rendering, so all of them draw strokes identically.
 */
function paint(
  canvas: HTMLCanvasElement,
  pts: DPoint[],
  styleOf: (color?: number, width?: number) => StrokeStyle,
): void {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  let style = styleOf();
  let px = 0;
  let py = 0;
  let havePrev = false;
  for (const [nx, ny, penDown, color, width] of pts) {
    const x = nx * w;
    const y = ny * h;
    if (penDown || !havePrev) {
      style = styleOf(color, width);
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.arc(x, y, style.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width;
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
 * Replay a drawing in black with one uniform width. Kept as a plain reference
 * renderer (benchmarks, tests); the app itself uses renderStyled / renderForAI.
 */
export function renderDrawing(canvas: HTMLCanvasElement, pts: DPoint[], lineWidth: number): void {
  paint(canvas, pts, () => ({ color: "#111", width: lineWidth }));
}

/**
 * Replay a drawing the way the player made it: each stroke in its own colour and
 * width. Widths scale with the canvas (420px is the reference), so the same
 * function renders the board and the small result thumbnails.
 */
export function renderStyled(canvas: HTMLCanvasElement, pts: DPoint[]): void {
  const scale = canvas.width / 420;
  paint(canvas, pts, (color, width) => ({
    color: PALETTE[color ?? DEFAULT_COLOR]?.hex ?? PALETTE[DEFAULT_COLOR].hex,
    width: (BRUSH_WIDTHS[width ?? DEFAULT_WIDTH] ?? BRUSH_WIDTHS[DEFAULT_WIDTH]) * scale,
  }));
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
