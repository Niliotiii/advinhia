import { renderStyled } from "./drawing";
import type { DPoint } from "./shared/protocol";
import { BRUSH_WIDTHS, DEFAULT_COLOR, DEFAULT_WIDTH, PALETTE } from "./shared/style";

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * Drawing surface (mouse + touch) on a white background.
 *
 * Everything drawn is also recorded as vector points with the stroke's colour
 * and width. That record is what gets submitted in multiplayer, redrawn by
 * undo, and shown to the AI — which always re-renders it in black with an ideal
 * width, so the colours and brush sizes chosen here are purely cosmetic.
 */
export class DrawingBoard {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private drawing = false;
  private lastX = 0;
  private lastY = 0;
  private _dirty = false;
  private enabled = true;
  private color = DEFAULT_COLOR;
  private width = DEFAULT_WIDTH;
  /** Everything drawn locally as normalized points (see DPoint). */
  private strokes: DPoint[] = [];
  private maxPoints = Infinity;
  private onLimit?: () => void;
  private onStrokeEnd?: () => void;
  private onSegment?: (nx: number, ny: number, isStart: boolean, color?: number, width?: number) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.ctx.lineJoin = "round";
    this.ctx.lineCap = "round";
    this.applyStyle();

    this.clear();
    this.attachEvents();
  }

  /** Register a callback fired whenever the user finishes a stroke. */
  setOnStrokeEnd(cb: () => void): void {
    this.onStrokeEnd = cb;
  }

  /**
   * Register a callback fired for each local drawing step with NORMALIZED
   * coordinates (0..1). `isStart` marks the first point of a new stroke (pen
   * down); only then are the colour/width indices passed. Used to stream the
   * drawing to other players.
   */
  setOnSegment(
    cb: (nx: number, ny: number, isStart: boolean, color?: number, width?: number) => void,
  ): void {
    this.onSegment = cb;
  }

  /** Choose the colour and/or width (indices into style.ts) of the NEXT strokes. */
  setStyle(style: { color?: number; width?: number }): void {
    if (style.color !== undefined && PALETTE[style.color]) this.color = style.color;
    if (style.width !== undefined && BRUSH_WIDTHS[style.width]) this.width = style.width;
    this.applyStyle();
  }

  getStyle(): { color: number; width: number } {
    return { color: this.color, width: this.width };
  }

  private applyStyle(): void {
    const hex = PALETTE[this.color].hex;
    this.ctx.strokeStyle = hex;
    this.ctx.fillStyle = hex;
    this.ctx.lineWidth = BRUSH_WIDTHS[this.width];
  }

  /**
   * Cap on recorded points. Once reached, no more ink is accepted and `onReached`
   * fires, so what is on screen always matches what gets submitted.
   */
  setPointLimit(max: number, onReached?: () => void): void {
    this.maxPoints = max;
    this.onLimit = onReached;
  }

  /**
   * Lock/unlock local drawing (e.g. outside the round time window). Locking
   * during a stroke ends it without firing the stroke-end callback.
   */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.drawing = false;
  }

  /** The local drawing as vector points (live array: copy it before keeping it). */
  getStrokes(): DPoint[] {
    return this.strokes;
  }

  /** True if anything has been drawn since the last clear. */
  get dirty(): boolean {
    return this._dirty;
  }

  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  clear(): void {
    this.ctx.fillStyle = "#fff";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.applyStyle();
    this._dirty = false;
    this.strokes = [];
    this.remote?.clear();
  }

  /** Remove the last stroke and repaint. Returns false if there was nothing to undo. */
  undo(): boolean {
    if (this.strokes.length === 0) return false;
    let i = this.strokes.length - 1;
    while (i > 0 && this.strokes[i][2] !== 1) i--;
    this.strokes.length = i; // drop from the last pen-down point to the end
    this.drawing = false;
    renderStyled(this.canvas, this.strokes);
    this.applyStyle();
    this._dirty = this.strokes.length > 0;
    return true;
  }

  private pos(e: MouseEvent | Touch): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  }

  private atLimit(): boolean {
    if (this.strokes.length < this.maxPoints) return false;
    this.drawing = false;
    this.onLimit?.();
    return true;
  }

  private start(x: number, y: number): void {
    if (!this.enabled || this.atLimit()) return;
    this.drawing = true;
    this.lastX = x;
    this.lastY = y;
    this.applyStyle();
    // Draw a dot so single taps register.
    this.ctx.beginPath();
    this.ctx.arc(x, y, this.ctx.lineWidth / 2, 0, Math.PI * 2);
    this.ctx.fill();
    this._dirty = true;
    this.strokes.push([
      round4(x / this.canvas.width),
      round4(y / this.canvas.height),
      1,
      this.color,
      this.width,
    ]);
    this.onSegment?.(x / this.canvas.width, y / this.canvas.height, true, this.color, this.width);
  }

  private move(x: number, y: number): void {
    if (!this.drawing || this.atLimit()) return;
    this.ctx.beginPath();
    this.ctx.moveTo(this.lastX, this.lastY);
    this.ctx.lineTo(x, y);
    this.ctx.stroke();
    this.lastX = x;
    this.lastY = y;
    this._dirty = true;
    const nx = round4(x / this.canvas.width);
    const ny = round4(y / this.canvas.height);
    const last = this.strokes[this.strokes.length - 1];
    if (!last || last[0] !== nx || last[1] !== ny) this.strokes.push([nx, ny, 0]);
    this.onSegment?.(x / this.canvas.width, y / this.canvas.height, false);
  }

  // Remote pens (other players' warm-up strokes in the lobby), one per peer id.
  private remote = new Map<string, { x: number; y: number; color: number; width: number }>();

  /**
   * Render a drawing step received from another player. Coordinates are
   * normalized (0..1). `isStart` begins a new stroke (pen down) with the given
   * colour/width indices; remote strokes never touch the local pen settings.
   */
  drawRemoteSegment(
    peerId: string,
    nx: number,
    ny: number,
    isStart: boolean,
    color?: number,
    width?: number,
  ): void {
    const x = nx * this.canvas.width;
    const y = ny * this.canvas.height;
    const prev = this.remote.get(peerId);
    const fresh = isStart || !prev;
    const c = fresh ? (color !== undefined && PALETTE[color] ? color : DEFAULT_COLOR) : prev.color;
    const w = fresh ? (width !== undefined && BRUSH_WIDTHS[width] ? width : DEFAULT_WIDTH) : prev.width;

    this.ctx.save();
    this.ctx.strokeStyle = PALETTE[c].hex;
    this.ctx.fillStyle = PALETTE[c].hex;
    this.ctx.lineWidth = BRUSH_WIDTHS[w];
    this.ctx.beginPath();
    if (fresh) {
      this.ctx.arc(x, y, BRUSH_WIDTHS[w] / 2, 0, Math.PI * 2);
      this.ctx.fill();
    } else {
      this.ctx.moveTo(prev.x, prev.y);
      this.ctx.lineTo(x, y);
      this.ctx.stroke();
    }
    this.ctx.restore();
    this.remote.set(peerId, { x, y, color: c, width: w });
    this._dirty = true;
  }

  /** Forget a remote peer's pen state (e.g. on clear or disconnect). */
  resetRemote(peerId?: string): void {
    if (peerId) this.remote.delete(peerId);
    else this.remote.clear();
  }

  private end(): void {
    if (!this.drawing) return;
    this.drawing = false;
    this.onStrokeEnd?.();
  }

  private attachEvents(): void {
    // Mouse
    this.canvas.addEventListener("mousedown", (e) => {
      const [x, y] = this.pos(e);
      this.start(x, y);
    });
    this.canvas.addEventListener("mousemove", (e) => {
      const [x, y] = this.pos(e);
      this.move(x, y);
    });
    window.addEventListener("mouseup", () => this.end());

    // Touch
    this.canvas.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        const [x, y] = this.pos(e.touches[0]);
        this.start(x, y);
      },
      { passive: false },
    );
    this.canvas.addEventListener(
      "touchmove",
      (e) => {
        e.preventDefault();
        const [x, y] = this.pos(e.touches[0]);
        this.move(x, y);
      },
      { passive: false },
    );
    this.canvas.addEventListener("touchend", (e) => {
      e.preventDefault();
      this.end();
    });
  }
}
