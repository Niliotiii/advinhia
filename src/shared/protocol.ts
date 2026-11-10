/**
 * Shared WebSocket protocol for AdivinhIA multiplayer.
 *
 * Game mode ("desenho simultâneo"): every player in the room draws the SAME
 * concepts, each with the SAME time limit. Drawings stay private while they
 * are made. When all rounds are done, the AI (running in each player's
 * browser) scores EVERY drawing as the probability it assigns to the
 * requested concept; a drawing's score is the median of all players'
 * evaluations (see scoring.ts) and the total decides the winner.
 *
 * Server flow:   lobby -> drawing -> between -> (drawing -> between)* ->
 *                judging -> results -> (host: playAgain) -> lobby
 *
 * Coordinates are normalized to [0,1] so they do not depend on canvas size.
 */

export type Phase = "lobby" | "drawing" | "between" | "judging" | "results";

export interface Player {
  id: string;
  name: string;
  /** false while a player is disconnected during a game (they can come back) */
  connected?: boolean;
}

export interface PromptRef {
  label: string; // model class name (English)
  pt: string; // display name (Portuguese)
}

// ---- Free-draw warm-up in the lobby (live relay) ----
export interface Point {
  x: number; // 0..1
  y: number; // 0..1
  /** true if this point begins a new stroke (pen down) */
  s?: boolean;
  /** colour / width index (see style.ts); only meaningful on pen-down points */
  c?: number;
  w?: number;
}

export interface Stroke {
  points: Point[];
}

// ---- Submitted drawings: compact tuples ----
/**
 * [x, y, penDown, colour?, width?]: x, y in [0,1]; penDown is 1 when the point
 * starts a new stroke. Only pen-down points carry the style (indices into
 * style.ts); later points of the stroke inherit it.
 */
export type DPoint = [number, number, number, number?, number?];

export interface DrawingEntry {
  playerId: string;
  round: number;
  pts: DPoint[];
}

export interface PlayerResult {
  id: string;
  name: string;
  connected: boolean;
  /** AI percentage (integer 0..100) given to the requested concept, per round */
  scores: number[];
  /** per round: the evaluators disagreed by more than 10 points (the median was used) */
  disputed: boolean[];
  /** sum of `scores` */
  total: number;
}

export interface Results {
  rounds: PromptRef[];
  players: PlayerResult[];
  /** ids with the highest total (more than one on a tie); empty if everyone scored 0 */
  winners: string[];
}

export type ErrorCode =
  | "not_host"
  | "bad_phase"
  | "not_enough_players"
  | "bad_settings"
  | "bad_scores"
  | "bad_drawing"
  | "in_progress"
  | "room_full";

// ---- Client → Server ----
export type ClientMessage =
  | { t: "join"; name: string; token?: string }
  | { t: "start"; rounds: number; seconds: number }
  | { t: "drawing"; round: number; pts: DPoint[] }
  /**
   * This player's evaluation of the drawings: playerId -> AI probability (0..1)
   * per round. An empty object means "I could not evaluate" (abstain).
   */
  | { t: "scores"; scores: Record<string, number[]> }
  | { t: "playAgain" }
  | { t: "stroke"; stroke: Stroke }
  | { t: "clear" }
  | { t: "chat"; text: string };

// ---- Server → Client ----
export type ServerMessage =
  | {
      t: "welcome";
      selfId: string;
      /** private reconnect token: store it locally, never shown to others */
      token: string;
      players: Player[];
      hostId: string | null;
      phase: Phase;
    }
  | { t: "presence"; players: Player[]; hostId: string | null }
  | { t: "gameStart"; rounds: number; seconds: number }
  | {
      t: "roundStart";
      round: number; // 0-based
      total: number;
      prompt: PromptRef;
      endsAt: number; // server clock (ms)
      serverNow: number; // server clock when sent, to compute the offset
    }
  | { t: "roundEnd"; round: number; nextAt: number; serverNow: number }
  | { t: "drawingAck"; round: number }
  | {
      t: "judging";
      deadline: number;
      serverNow: number;
      rounds: PromptRef[];
      /** every submitted drawing: each browser scores all of them */
      drawings: DrawingEntry[];
    }
  | { t: "results"; results: Results; drawings: DrawingEntry[] }
  | { t: "lobby" }
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "stroke"; from: string; stroke: Stroke }
  | { t: "clear"; from: string }
  | { t: "chat"; from: string; name: string; text: string };

export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;
export const MAX_NAME_LEN = 24;
export const MAX_CHAT_LEN = 200;

export const ROUNDS_OPTIONS = [3, 6, 10] as const;
export const SECONDS_OPTIONS = [15, 20, 30] as const;

/** Upper bound of points accepted for a single drawing. */
export const MAX_DRAWING_POINTS = 4000;
