/**
 * Shared WebSocket message protocol for AdivinhIA multiplayer (Fase 0+1).
 *
 * Used by both the client (src/net.ts) and the server (Durable Object
 * GameRoom). At this stage the server is just a real-time relay: it tracks
 * presence and broadcasts drawing strokes / clear / chat between players.
 * The game state machine still lives on the client and will migrate to the
 * server in a later phase.
 *
 * Coordinates in strokes are normalized to [0,1] so they are independent of
 * each client's canvas size.
 */

export interface Point {
  x: number; // 0..1
  y: number; // 0..1
  /** true if this point begins a new stroke (pen down) */
  s?: boolean;
}

/** A single drawn segment: a polyline of normalized points. */
export interface Stroke {
  points: Point[];
}

export interface Player {
  id: string;
  name: string;
}

// ---- Client → Server ----
export type ClientMessage =
  | { t: "join"; name: string }
  | { t: "stroke"; stroke: Stroke }
  | { t: "clear" }
  | { t: "chat"; text: string };

// ---- Server → Client ----
export type ServerMessage =
  | { t: "welcome"; selfId: string; players: Player[] }
  | { t: "presence"; players: Player[] }
  | { t: "stroke"; from: string; stroke: Stroke }
  | { t: "clear"; from: string }
  | { t: "chat"; from: string; name: string; text: string };

export const MAX_PLAYERS = 8;
export const MAX_NAME_LEN = 24;
export const MAX_CHAT_LEN = 200;
