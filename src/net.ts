import type { ClientMessage, DPoint, Point, ServerMessage } from "./shared/protocol";

export type ConnStatus = "connecting" | "open" | "reconnecting" | "closed";

interface Handlers {
  onMessage: (msg: ServerMessage) => void;
  onStatus?: (status: ConnStatus) => void;
}

const TOKEN_KEY = "adivinhia.token";
/** Delays (ms) between reconnection attempts after an unexpected drop. */
const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];
/** Close codes sent by the server that must NOT trigger a reconnect. */
const NO_RETRY_CODES = new Set([4000 /* replaced by another tab */, 4003 /* rejected */]);

/**
 * Private reconnect token. Kept per tab (sessionStorage) so two tabs of the
 * same browser are two different players, while a reload keeps the identity.
 */
function getToken(): string {
  try {
    let t = sessionStorage.getItem(TOKEN_KEY);
    if (!t) {
      t = crypto.randomUUID();
      sessionStorage.setItem(TOKEN_KEY, t);
    }
    return t;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * WebSocket client for a game room. Joins with the private token (so a
 * dropped player gets their identity and the current game state back) and
 * reconnects automatically after unexpected disconnections.
 *
 * Lobby warm-up strokes are coalesced: points gathered within a short window
 * go out as a single message (the Durable Object docs recommend batching).
 */
export class RoomClient {
  private ws: WebSocket | null = null;
  private readonly handlers: Handlers;
  private readonly code: string;
  private readonly name: string;
  private readonly token = getToken();
  private intentionalClose = false;
  private attempt = 0;
  private retryTimer: number | null = null;

  private strokeBuf: Point[] = [];
  private flushTimer: number | null = null;
  private static readonly FLUSH_MS = 60;

  constructor(code: string, name: string, handlers: Handlers) {
    this.code = code;
    this.name = name;
    this.handlers = handlers;
  }

  connect(): void {
    this.handlers.onStatus?.(this.attempt === 0 ? "connecting" : "reconnecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/room/${encodeURIComponent(this.code)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.attempt = 0;
      this.send({ t: "join", name: this.name, token: this.token });
      this.handlers.onStatus?.("open");
    });

    ws.addEventListener("message", (ev) => {
      if (ws !== this.ws) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      this.handlers.onMessage(msg);
    });

    ws.addEventListener("close", (ev) => {
      if (ws !== this.ws) return; // a stale socket
      this.ws = null;
      if (this.intentionalClose || NO_RETRY_CODES.has(ev.code)) {
        this.handlers.onStatus?.("closed");
        return;
      }
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    if (this.attempt >= RETRY_DELAYS.length) {
      this.handlers.onStatus?.("closed");
      return;
    }
    this.handlers.onStatus?.("reconnecting");
    const delay = RETRY_DELAYS[this.attempt++];
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  close(): void {
    this.intentionalClose = true;
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    this.ws?.close(1000, "bye");
    this.ws = null;
  }

  // ---- lobby warm-up (live relay) ----

  /** Queue a drawn point; flushed in a batch shortly after. */
  sendPoint(x: number, y: number, isStart: boolean): void {
    this.strokeBuf.push({ x, y, s: isStart || undefined });
    if (this.flushTimer === null) {
      this.flushTimer = window.setTimeout(() => this.flushStroke(), RoomClient.FLUSH_MS);
    }
  }

  private flushStroke(): void {
    this.flushTimer = null;
    if (this.strokeBuf.length === 0) return;
    const points = this.strokeBuf;
    this.strokeBuf = [];
    this.send({ t: "stroke", stroke: { points } });
  }

  sendClear(): void {
    this.flushStroke(); // keep ordering
    this.send({ t: "clear" });
  }

  sendChat(text: string): void {
    this.send({ t: "chat", text });
  }

  // ---- game ----

  sendStart(rounds: number, seconds: number): void {
    this.send({ t: "start", rounds, seconds });
  }

  sendDrawing(round: number, pts: DPoint[]): void {
    this.send({ t: "drawing", round, pts });
  }

  sendScores(scores: Record<string, number[]>): void {
    this.send({ t: "scores", scores });
  }

  sendPlayAgain(): void {
    this.send({ t: "playAgain" });
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
