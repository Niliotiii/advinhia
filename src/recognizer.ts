import * as tf from "@tensorflow/tfjs-core";
import { loadLayersModel, type LayersModel } from "@tensorflow/tfjs-layers";
// Register backends via side-effect imports. WebGL is the fast path (GPU);
// the CPU backend is kept as a universal fallback. Importing only these two
// (instead of the whole @tensorflow/tfjs meta-package) is what shrinks the
// bundle dramatically — we drop WASM, node, data, viz, and unused ops setup.
import "@tensorflow/tfjs-backend-webgl";
import "@tensorflow/tfjs-backend-cpu";

/**
 * Local sketch recognizer backed by the doodleNet QuickDraw CNN
 * (345 classes, trained on Google's "Quick, Draw!" dataset).
 *
 * Everything runs in the browser via TensorFlow.js (WebGL/CPU backend).
 * No image is ever sent to a server — this is the whole point of the design:
 * zero network latency per inference, zero bandwidth cost, no API rate limits.
 */

const MODEL_URL = "/model/model.json";
const CLASS_NAMES_URL = "/model/class_names.txt";
const INPUT_SIZE = 28; // model expects a 28x28x1 grayscale tensor

export interface Prediction {
  label: string;
  /** probability in [0, 1] */
  probability: number;
}

export class SketchRecognizer {
  private model: LayersModel | null = null;
  private classNames: string[] = [];
  private ready = false;

  /** Load the TF.js model + class labels. Call once at startup. */
  async load(): Promise<void> {
    // Prefer the WebGL (GPU) backend; fall back to CPU if unavailable.
    try {
      await tf.setBackend("webgl");
    } catch {
      await tf.setBackend("cpu");
    }
    await tf.ready();

    const [model, classText] = await Promise.all([
      loadLayersModel(MODEL_URL),
      fetch(CLASS_NAMES_URL).then((r) => r.text()),
    ]);

    this.model = model;
    this.classNames = classText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Warm up the model so the first real inference isn't slow
    // (shader compilation / backend init happens here instead).
    tf.tidy(() => {
      const warm = tf.zeros([1, INPUT_SIZE, INPUT_SIZE, 1]);
      (this.model!.predict(warm) as tf.Tensor).dataSync();
    });

    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  get labels(): string[] {
    return this.classNames;
  }

  // ---- Temporal smoothing ----
  // Raw per-frame predictions are jittery (the top class can flip between
  // neighboring inferences). We keep a short history of probability vectors
  // and average them, which stabilizes the displayed guesses and reduces
  // false positives without adding perceptible lag.
  private history: Float32Array[] = [];
  private static readonly SMOOTH_WINDOW = 4;

  // The last preprocessed 28x28 input (values in [0,1]), exposed so the UI
  // can render "what the AI sees".
  private lastInput: Float32Array | null = null;

  /** Clear smoothing history + last input. Call at the start of each round. */
  reset(): void {
    this.history = [];
    this.lastInput = null;
  }

  /** The most recent 28x28 normalized input, or null if nothing drawn yet. */
  getLastInput(): Float32Array | null {
    return this.lastInput;
  }

  /**
   * Run inference on the given drawing canvas and return the top-K guesses,
   * smoothed over the last few frames (see SMOOTH_WINDOW).
   *
   * Preprocessing mirrors how the Quick, Draw! data is normalized — this is
   * the critical part. The model was trained on drawings that fill the 28x28
   * frame, so we cannot just downscale the raw canvas (a small stroke in a
   * big canvas becomes an unrecognizable blob). Instead we:
   *   1. find the bounding box of the drawn strokes
   *   2. crop to it
   *   3. scale it (preserving aspect ratio) into a 28x28 frame, centered
   *   4. invert (255 - v) and normalize to [0, 1]
   * Returns an empty array only if nothing is drawn.
   */
  predict(source: HTMLCanvasElement, topK = 5): Prediction[] {
    if (!this.model) throw new Error("Model not loaded");

    const input = this.preprocess(source);
    if (!input) {
      this.lastInput = null;
      this.history = [];
      return [];
    }
    this.lastInput = input;

    const raw = tf.tidy(() => {
      // input is a Float32Array of length 28*28 already normalized to [0,1].
      const tensor = tf.tensor(input, [1, INPUT_SIZE, INPUT_SIZE, 1]);
      const output = this.model!.predict(tensor) as tf.Tensor;
      return output.dataSync() as Float32Array;
    });

    // Push into the moving-average window.
    this.history.push(raw);
    if (this.history.length > SketchRecognizer.SMOOTH_WINDOW) {
      this.history.shift();
    }

    // Average the probability vectors across the window.
    const n = raw.length;
    const avg = new Float32Array(n);
    for (const vec of this.history) {
      for (let i = 0; i < n; i++) avg[i] += vec[i];
    }
    const k = this.history.length;
    for (let i = 0; i < n; i++) avg[i] /= k;

    const scored: Prediction[] = Array.from(avg).map((probability, index) => ({
      label: this.classNames[index] ?? `class_${index}`,
      probability,
    }));

    scored.sort((a, b) => b.probability - a.probability);
    return scored.slice(0, topK);
  }

  /**
   * Turn the drawing canvas into a normalized 28x28 Float32Array (values in
   * [0,1], bright strokes on a dark background), using bounding-box crop +
   * centered scaling. Returns null if the canvas is effectively empty.
   */
  private preprocess(source: HTMLCanvasElement): Float32Array | null {
    const sctx = source.getContext("2d", { willReadFrequently: true });
    if (!sctx) return null;

    const { width: w, height: h } = source;
    const data = sctx.getImageData(0, 0, w, h).data;

    // Find bounding box of non-white pixels. The board draws dark strokes
    // (#111) on a white (#fff) background, so "ink" = dark pixels.
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    const INK_THRESHOLD = 200; // luminance below this counts as a stroke
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // approximate luminance from RGB
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < INK_THRESHOLD) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < 0) return null; // nothing drawn

    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;

    // Scale the stroke to fill most of the 28x28 frame (a ~1px margin).
    // The Quick, Draw! bitmaps the model was trained on are centered and
    // scaled to fill the frame, so a small target (e.g. 20) with big margins
    // pushes the input off the training distribution and wrecks accuracy.
    // Verified empirically against official QuickDraw samples: 26 >> 20.
    const TARGET = 26;
    const scale = TARGET / Math.max(boxW, boxH);
    const drawW = Math.max(1, Math.round(boxW * scale));
    const drawH = Math.max(1, Math.round(boxH * scale));
    const offsetX = Math.floor((INPUT_SIZE - drawW) / 2);
    const offsetY = Math.floor((INPUT_SIZE - drawH) / 2);

    // Render the cropped+scaled stroke onto a 28x28 offscreen canvas.
    const off = document.createElement("canvas");
    off.width = INPUT_SIZE;
    off.height = INPUT_SIZE;
    const octx = off.getContext("2d", { willReadFrequently: true });
    if (!octx) return null;
    octx.fillStyle = "#fff";
    octx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    octx.imageSmoothingEnabled = true;
    octx.drawImage(
      source,
      minX,
      minY,
      boxW,
      boxH,
      offsetX,
      offsetY,
      drawW,
      drawH,
    );

    // Read back, convert to grayscale, invert, normalize.
    const small = octx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
    const out = new Float32Array(INPUT_SIZE * INPUT_SIZE);
    for (let p = 0; p < INPUT_SIZE * INPUT_SIZE; p++) {
      const i = p * 4;
      const lum = 0.299 * small[i] + 0.587 * small[i + 1] + 0.114 * small[i + 2];
      out[p] = (255 - lum) / 255; // invert + normalize
    }
    return out;
  }
}
