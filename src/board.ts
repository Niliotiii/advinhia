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
