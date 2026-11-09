/**
 * Simple drawing surface: black strokes on a white background, supporting
 * both mouse and touch. White background matters — the recognizer inverts
 * the image, so "empty" must be white (which becomes 0 after inversion).
 */
export class DrawingBoard {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private drawing = false;
  private lastX = 0;
  private lastY = 0;
  private _dirty = false;
  private onStrokeEnd?: () => void;
  private onSegment?: (nx: number, ny: number, isStart: boolean) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.ctx.lineJoin = "round";
    this.ctx.lineCap = "round";
    this.ctx.lineWidth = 14;
    this.ctx.strokeStyle = "#111";

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
   * down), so remote peers know not to connect it to the previous point.
   * Used to stream the drawing to other players.
   */
  setOnSegment(cb: (nx: number, ny: number, isStart: boolean) => void): void {
    this.onSegment = cb;
  }

  /** Set the pen width in canvas pixels (applies to local and remote strokes). */
  setBrushSize(px: number): void {
    this.ctx.lineWidth = px;
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
    this._dirty = false;
    this.remoteLast?.clear();
  }

  private pos(e: MouseEvent | Touch): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  }

  private start(x: number, y: number): void {
    this.drawing = true;
    this.lastX = x;
    this.lastY = y;
    // Draw a dot so single taps register.
    this.ctx.beginPath();
    this.ctx.arc(x, y, this.ctx.lineWidth / 2, 0, Math.PI * 2);
    this.ctx.fillStyle = "#111";
    this.ctx.fill();
    this._dirty = true;
    this.onSegment?.(x / this.canvas.width, y / this.canvas.height, true);
  }

  private move(x: number, y: number): void {
    if (!this.drawing) return;
    this.ctx.beginPath();
    this.ctx.moveTo(this.lastX, this.lastY);
    this.ctx.lineTo(x, y);
    this.ctx.stroke();
    this.lastX = x;
    this.lastY = y;
    this._dirty = true;
    this.onSegment?.(x / this.canvas.width, y / this.canvas.height, false);
  }

  // Remote pen position per peer id (normalized → pixels tracked here).
  private remoteLast = new Map<string, { x: number; y: number }>();

  /**
   * Render a drawing step received from another player. Coordinates are
   * normalized (0..1). `isStart` begins a new stroke (pen down).
   */
  drawRemoteSegment(peerId: string, nx: number, ny: number, isStart: boolean): void {
    const x = nx * this.canvas.width;
    const y = ny * this.canvas.height;
    if (isStart || !this.remoteLast.has(peerId)) {
      this.ctx.beginPath();
      this.ctx.arc(x, y, this.ctx.lineWidth / 2, 0, Math.PI * 2);
      this.ctx.fillStyle = "#111";
      this.ctx.fill();
    } else {
      const prev = this.remoteLast.get(peerId)!;
      this.ctx.beginPath();
      this.ctx.moveTo(prev.x, prev.y);
      this.ctx.lineTo(x, y);
      this.ctx.strokeStyle = "#111";
      this.ctx.stroke();
    }
    this.remoteLast.set(peerId, { x, y });
    this._dirty = true;
  }

  /** Forget a remote peer's pen state (e.g. on clear or disconnect). */
  resetRemote(peerId?: string): void {
    if (peerId) this.remoteLast.delete(peerId);
    else this.remoteLast.clear();
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
