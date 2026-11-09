import { DurableObject } from "cloudflare:workers";
import type {
  ClientMessage,
  ServerMessage,
  Player,
} from "../shared/protocol";
import { MAX_PLAYERS, MAX_NAME_LEN, MAX_CHAT_LEN } from "../shared/protocol";

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
}

/** Per-connection state persisted across hibernation via serializeAttachment. */
interface ConnState {
  id: string;
  name: string;
}

/**
 * GameRoom — one Durable Object instance per room code. Acts as a real-time
 * relay (Fase 0+1): tracks presence and broadcasts strokes / clear / chat.
 *
 * Uses the WebSocket Hibernation API (ctx.acceptWebSocket) so the room can be
 * evicted from memory while players stay connected, and only wakes on a
 * message. Per-connection identity survives hibernation through
 * serializeAttachment; we never hold authoritative state only in memory.
 */
export class GameRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) {
      return new Response("Room full", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept with hibernation support.
    this.ctx.acceptWebSocket(server);

    // Assign an identity now; name is set when the client sends "join".
    const state: ConnState = {
      id: crypto.randomUUID().slice(0, 8),
      name: "",
    };
    server.serializeAttachment(state);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return; // ignore malformed frames
    }

    const state = ws.deserializeAttachment() as ConnState | null;
    if (!state) return;

    switch (msg.t) {
      case "join": {
        state.name = sanitize(msg.name, MAX_NAME_LEN) || `jogador-${state.id}`;
        ws.serializeAttachment(state);
        // Tell the newcomer who they are and who's here.
        this.sendTo(ws, { t: "welcome", selfId: state.id, players: this.roster() });
        // Tell everyone the updated roster.
        this.broadcast({ t: "presence", players: this.roster() });
        break;
      }
      case "stroke": {
        if (!state.name) return;
        // Relay to everyone except the sender.
        this.broadcast({ t: "stroke", from: state.id, stroke: msg.stroke }, ws);
        break;
      }
      case "clear": {
        if (!state.name) return;
        this.broadcast({ t: "clear", from: state.id }, ws);
        break;
      }
      case "chat": {
        if (!state.name) return;
        const text = sanitize(msg.text, MAX_CHAT_LEN);
        if (!text) return;
        this.broadcast({ t: "chat", from: state.id, name: state.name, text });
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Close is auto-replied by the runtime; just update presence.
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
    // The closing socket is still briefly in getWebSockets(); exclude it.
    this.broadcast({ t: "presence", players: this.roster(ws) });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcast({ t: "presence", players: this.roster(ws) });
  }

  // ---- helpers ----

  /** Current connected players, optionally excluding one socket. */
  private roster(exclude?: WebSocket): Player[] {
    const players: Player[] = [];
    for (const sock of this.ctx.getWebSockets()) {
      if (sock === exclude) continue;
      const s = sock.deserializeAttachment() as ConnState | null;
      if (s && s.name) players.push({ id: s.id, name: s.name });
    }
    return players;
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket gone */
    }
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const sock of this.ctx.getWebSockets()) {
      if (sock === except) continue;
      try {
        sock.send(data);
      } catch {
        /* skip dead sockets */
      }
    }
  }
}

function sanitize(input: unknown, maxLen: number): string {
  if (typeof input !== "string") return "";
  // Strip control chars, collapse whitespace, trim, cap length.
  return input
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}
