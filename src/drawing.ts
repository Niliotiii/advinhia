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
