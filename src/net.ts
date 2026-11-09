import type {
  ClientMessage,
  ServerMessage,
  Stroke,
  Player,
} from "./shared/protocol";

type Handlers = {
  onWelcome?: (selfId: string, players: Player[]) => void;
  onPresence?: (players: Player[]) => void;
  onStroke?: (from: string, stroke: Stroke) => void;
  onClear?: (from: string) => void;
  onChat?: (from: string, name: string, text: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

/**
 * Thin WebSocket client for a game room. Connects to /room/:code, sends the
 * join handshake, and dispatches server messages to handlers.
 *
 * Outgoing strokes are coalesced: points accumulated within a short window are
 * flushed as a single "stroke" message to cut per-frame WebSocket overhead
 * (the server docs recommend batching at ~50–100ms).
 */
export class RoomClient {
  private ws: WebSocket | null = null;
  private readonly handlers: Handlers;
  private readonly code: string;
  private readonly name: string;

  private strokeBuf: Stroke["points"] = [];
  private flushTimer: number | null = null;
  private static readonly FLUSH_MS = 60;

  selfId = "";

  constructor(code: string, name: string, handlers: Handlers) {
    this.code = code;
    this.name = name;
    this.handlers = handlers;
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/room/${encodeURIComponent(this.code)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.send({ t: "join", name: this.name });
      this.handlers.onOpen?.();
    });

    ws.addEventListener("message", (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      this.dispatch(msg);
    });

    ws.addEventListener("close", () => this.handlers.onClose?.());
    ws.addEventListener("error", () => this.handlers.onClose?.());
  }

  close(): void {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  // ---- outgoing ----

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
    // Flush any pending points first so ordering is preserved.
    this.flushStroke();
    this.send({ t: "clear" });
  }

  sendChat(text: string): void {
    this.send({ t: "chat", text });
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ---- incoming ----

  private dispatch(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.selfId = msg.selfId;
        this.handlers.onWelcome?.(msg.selfId, msg.players);
        break;
      case "presence":
        this.handlers.onPresence?.(msg.players);
        break;
      case "stroke":
        this.handlers.onStroke?.(msg.from, msg.stroke);
        break;
      case "clear":
        this.handlers.onClear?.(msg.from);
        break;
      case "chat":
        this.handlers.onChat?.(msg.from, msg.name, msg.text);
        break;
    }
  }
}
