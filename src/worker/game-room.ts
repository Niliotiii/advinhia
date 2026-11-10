import { DurableObject } from "cloudflare:workers";
import type {
  ClientMessage,
  DPoint,
  DrawingEntry,
  ErrorCode,
  Phase,
  Player,
  PromptRef,
  Results,
  ServerMessage,
} from "../shared/protocol";
import {
  MAX_CHAT_LEN,
  MAX_DRAWING_POINTS,
  MAX_NAME_LEN,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROUNDS_OPTIONS,
  SECONDS_OPTIONS,
} from "../shared/protocol";
import { PROMPTS } from "../shared/prompts";
import { aggregateDrawing } from "../shared/scoring";

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
}

/** Pause between two drawings; also the window to deliver the finished drawing. */
const BREAK_MS = 3_000;
/** How long clients get to evaluate their drawings with the local AI. */
const JUDGE_TIMEOUT_MS = 25_000;
/** Largest accepted WebSocket text frame (a 4000-point drawing is ~70 KB). */
const MAX_MESSAGE_CHARS = 200_000;
const TOKEN_RE = /^[A-Za-z0-9-]{16,64}$/;

/** Per-connection state kept across hibernation. `id` is null until "join". */
interface ConnState {
  id: string | null;
}

interface StoredPlayer {
  id: string; // public id, shown to everyone
  token: string; // private reconnect token — never broadcast
  name: string;
  connected: boolean;
}

interface GameState {
  phase: Phase;
  hostId: string | null;
  players: StoredPlayer[];
  settings: { rounds: number; seconds: number };
  deck: PromptRef[];
  round: number; // index of the current drawing, -1 before the game starts
  /** Deadline of the current timed phase (drawing / between / judging), server clock. */
  endsAt: number;
  /**
   * evaluatorId -> (playerId -> AI probability 0..1 per round). A key exists once
   * that player has reported (an empty object means they abstained).
   */
  reports: Record<string, Record<string, number[]>>;
  results: Results | null;
}

type DrawingRow = { player_id: string; round: number; pts: string };

function freshGame(): GameState {
  return {
    phase: "lobby",
    hostId: null,
    players: [],
    settings: { rounds: 3, seconds: 20 },
    deck: [],
    round: -1,
    endsAt: 0,
    reports: {},
    results: null,
  };
}

/**
 * GameRoom — one Durable Object per room code. It owns the whole game:
 * who is in the room, the shared concepts, the synchronized round timer,
 * the submitted drawings and the final ranking. Clients only render state
 * and run the AI locally on their own drawings.
 *
 * State is written to storage before it is announced ("persist first"), so
 * the room survives hibernation/eviction; phase changes are driven by the
 * single DO alarm.
 */
export class GameRoom extends DurableObject<Env> {
  private game: GameState = freshGame();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS drawings (
           player_id TEXT NOT NULL,
           round INTEGER NOT NULL,
           pts TEXT NOT NULL,
           PRIMARY KEY (player_id, round)
         )`,
      );
      const saved = await this.ctx.storage.get<GameState>("game");
      if (saved) this.game = saved;
      this.game.reports ??= {}; // state saved by an older version had `scores` instead

      // Re-derive who is connected from the live sockets (the stored flags may
      // be stale after a crash or restart).
      const live = new Set(this.liveIds());
      for (const p of this.game.players) p.connected = live.has(p.id);
      if (this.game.phase === "lobby") {
        this.game.players = this.game.players.filter((p) => p.connected);
        this.ensureHost();
      }
    });
  }

  // ------------------------------------------------------------------ sockets

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    // Small slack above MAX_PLAYERS so a reconnect can overlap its stale socket.
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS + 4) {
      return new Response("Room full", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: null } satisfies ConnState);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_CHARS) return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return; // ignore malformed frames
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.t === "join") {
      await this.onJoin(ws, msg);
      return;
    }

    const me = this.playerOf(ws);
    if (!me) return; // must join first

    switch (msg.t) {
      case "start":
        await this.onStart(ws, me, msg);
        break;
      case "drawing":
        await this.onDrawing(ws, me, msg);
        break;
      case "scores":
        await this.onScores(ws, me, msg);
        break;
      case "playAgain":
        await this.onPlayAgain(ws, me);
        break;
      case "stroke":
        // Live relay is only a lobby warm-up: during a game drawings are private.
        if (this.game.phase === "lobby") {
          this.broadcast({ t: "stroke", from: me.id, stroke: msg.stroke }, ws);
        }
        break;
      case "clear":
        if (this.game.phase === "lobby") this.broadcast({ t: "clear", from: me.id }, ws);
        break;
      case "chat": {
        const text = sanitize(msg.text, MAX_CHAT_LEN);
        if (text) this.broadcast({ t: "chat", from: me.id, name: me.name, text });
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Reply with a code that is legal to SEND: a client closing without a status
    // arrives as 1005 (or 1006 when abnormal), and echoing those throws, which
    // would leave the closing handshake unfinished.
    const reply = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
    try {
      ws.close(reply, reason);
    } catch {
      /* already closing */
    }
    await this.onDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onDisconnect(ws);
  }

  // ----------------------------------------------------------------- handlers

  private async onJoin(ws: WebSocket, msg: Extract<ClientMessage, { t: "join" }>): Promise<void> {
    const g = this.game;
    const name = sanitize(msg.name, MAX_NAME_LEN);
    let token = typeof msg.token === "string" && TOKEN_RE.test(msg.token) ? msg.token : null;
    let player = token ? g.players.find((p) => p.token === token) : undefined;

    if (!player) {
      if (g.phase !== "lobby") {
        return this.reject(ws, "in_progress", "Partida em andamento. Entre quando ela terminar.");
      }
      if (g.players.length >= MAX_PLAYERS) {
        return this.reject(ws, "room_full", "A sala está cheia.");
      }
      token = token ?? crypto.randomUUID();
      const id = crypto.randomUUID().slice(0, 8);
      player = { id, token, name: name || `jogador-${id.slice(0, 4)}`, connected: true };
      g.players.push(player);
      if (!g.hostId) g.hostId = player.id;
    } else {
      // Reconnection: the newest socket wins, the stale one is dropped quietly.
      for (const old of this.ctx.getWebSockets()) {
        const s = old.deserializeAttachment() as ConnState | null;
        if (old !== ws && s?.id === player.id) {
          old.serializeAttachment({ id: null } satisfies ConnState);
          try {
            old.close(4000, "replaced");
          } catch {
            /* ignore */
          }
        }
      }
      player.connected = true;
      if (name) player.name = name;
    }

    ws.serializeAttachment({ id: player.id } satisfies ConnState);
    // A room left without a host (everyone dropped) is taken over by whoever returns first.
    if (!g.hostId || !g.players.some((p) => p.id === g.hostId)) g.hostId = player.id;
    await this.persist();

    this.send(ws, {
      t: "welcome",
      selfId: player.id,
      token: player.token,
      players: this.publicPlayers(),
      hostId: g.hostId,
      phase: g.phase,
    });
    this.syncPhase(ws);
    this.broadcastPresence();
  }

  private async onStart(
    ws: WebSocket,
    me: StoredPlayer,
    msg: Extract<ClientMessage, { t: "start" }>,
  ): Promise<void> {
    const g = this.game;
    if (me.id !== g.hostId) return this.fail(ws, "not_host", "Só o anfitrião pode iniciar a partida.");
    if (g.phase !== "lobby") return this.fail(ws, "bad_phase", "A partida já começou.");
    if (g.players.filter((p) => p.connected).length < MIN_PLAYERS) {
      return this.fail(ws, "not_enough_players", `São necessários pelo menos ${MIN_PLAYERS} jogadores.`);
    }
    if (
      !(ROUNDS_OPTIONS as readonly number[]).includes(msg.rounds) ||
      !(SECONDS_OPTIONS as readonly number[]).includes(msg.seconds)
    ) {
      return this.fail(ws, "bad_settings", "Configuração de partida inválida.");
    }

    g.settings = { rounds: msg.rounds, seconds: msg.seconds };
    g.deck = pickDeck(msg.rounds);
    g.round = -1;
    g.reports = {};
    g.results = null;
    this.ctx.storage.sql.exec("DELETE FROM drawings");

    this.broadcast({ t: "gameStart", rounds: g.settings.rounds, seconds: g.settings.seconds });
    await this.startRound(0);
  }

  private async onDrawing(
    ws: WebSocket,
    me: StoredPlayer,
    msg: Extract<ClientMessage, { t: "drawing" }>,
  ): Promise<void> {
    const g = this.game;
    if ((g.phase !== "drawing" && g.phase !== "between") || msg.round !== g.round) {
      return this.fail(ws, "bad_phase", "Fora do tempo de envio deste desenho.");
    }
    const pts = sanitizePoints(msg.pts);
    if (!pts) return this.fail(ws, "bad_drawing", "Desenho inválido.");

    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO drawings (player_id, round, pts) VALUES (?, ?, ?)",
      me.id,
      g.round,
      JSON.stringify(pts),
    );
    this.send(ws, { t: "drawingAck", round: g.round });
  }

  private async onScores(
    ws: WebSocket,
    me: StoredPlayer,
    msg: Extract<ClientMessage, { t: "scores" }>,
  ): Promise<void> {
    const g = this.game;
    if (g.phase !== "judging") return this.fail(ws, "bad_phase", "Não estamos na fase de avaliação.");
    if (g.reports[me.id]) return; // first report wins

    const raw: unknown = msg.scores;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return this.fail(ws, "bad_scores", "Pontuações inválidas.");
    }

    // Keep only well-formed entries about players that are in this game.
    const clean: Record<string, number[]> = {};
    for (const p of g.players) {
      if (!Object.prototype.hasOwnProperty.call(raw, p.id)) continue;
      const arr = (raw as Record<string, unknown>)[p.id];
      if (
        Array.isArray(arr) &&
        arr.length === g.deck.length &&
        arr.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)
      ) {
        clean[p.id] = (arr as number[]).map((v) => Math.round(v * 10000) / 10000);
      }
    }

    g.reports[me.id] = clean;
    await this.persist();
    await this.maybeFinalize();
  }

  private async onPlayAgain(ws: WebSocket, me: StoredPlayer): Promise<void> {
    if (me.id !== this.game.hostId) return this.fail(ws, "not_host", "Só o anfitrião pode reiniciar.");
    if (this.game.phase !== "results") return this.fail(ws, "bad_phase", "A partida ainda não terminou.");
    await this.resetToLobby();
  }

  private async onDisconnect(ws: WebSocket): Promise<void> {
    const s = ws.deserializeAttachment() as ConnState | null;
    if (!s?.id) return; // never joined, or replaced by a newer socket
    const g = this.game;
    const p = g.players.find((x) => x.id === s.id);
    if (!p) return;

    // The player may already have reconnected on a fresh socket.
    const stillThere = this.ctx
      .getWebSockets()
      .some((x) => x !== ws && (x.deserializeAttachment() as ConnState | null)?.id === p.id);
    if (stillThere) return;

    p.connected = false;
    if (g.phase === "lobby") {
      g.players = g.players.filter((x) => x.id !== p.id);
    }
    // The host only changes hands where it matters (lobby: start, results:
    // play again). During a game a dropped host keeps the role so that they
    // can come back to it.
    if (g.phase === "lobby" || g.phase === "results") this.ensureHost();
    await this.persist();
    this.broadcastPresence();
    await this.maybeFinalize(); // someone who owed scores may have left
  }

  // ------------------------------------------------------------ phase machine

  /** Drives timed transitions: end of a drawing, end of a break, judging timeout. */
  async alarm(): Promise<void> {
    const g = this.game;
    const timed = g.phase === "drawing" || g.phase === "between" || g.phase === "judging";
    if (!timed) return;

    if (Date.now() < g.endsAt - 250) {
      await this.ctx.storage.setAlarm(g.endsAt); // woke up early; wait the rest
      return;
    }

    switch (g.phase) {
      case "drawing": {
        g.phase = "between";
        g.endsAt = Date.now() + BREAK_MS;
        await this.persist();
        await this.ctx.storage.setAlarm(g.endsAt);
        this.broadcast({ t: "roundEnd", round: g.round, nextAt: g.endsAt, serverNow: Date.now() });
        break;
      }
      case "between": {
        if (!g.players.some((p) => p.connected)) {
          await this.resetToLobby(); // everyone left: abandon the game
        } else if (g.round + 1 < g.deck.length) {
          await this.startRound(g.round + 1);
        } else {
          await this.startJudging();
        }
        break;
      }
      case "judging": {
        await this.finalize(); // timeout: whoever did not report scores 0
        break;
      }
    }
  }

  private async startRound(index: number): Promise<void> {
    const g = this.game;
    g.phase = "drawing";
    g.round = index;
    g.endsAt = Date.now() + g.settings.seconds * 1000;
    await this.persist();
    await this.ctx.storage.setAlarm(g.endsAt);
    this.broadcast(this.roundStartMsg());
  }

  private async startJudging(): Promise<void> {
    const g = this.game;
    g.phase = "judging";
    g.reports = {};
    g.endsAt = Date.now() + JUDGE_TIMEOUT_MS;
    await this.persist();
    await this.ctx.storage.setAlarm(g.endsAt);
    this.broadcast(this.judgingMsg());
    await this.maybeFinalize(); // nobody has anything to evaluate -> finish now
  }

  /** Finish judging as soon as every connected player has reported (or abstained). */
  private async maybeFinalize(): Promise<void> {
    const g = this.game;
    if (g.phase !== "judging") return;
    const anyDrawing = this.ctx.storage.sql.exec("SELECT 1 FROM drawings LIMIT 1").toArray().length > 0;
    const pending = g.players.filter((p) => p.connected && !g.reports[p.id]);
    if (!anyDrawing || pending.length === 0) await this.finalize();
  }

  private async finalize(): Promise<void> {
    const g = this.game;
    const drawn = new Set(this.allDrawings().map((d) => `${d.playerId}:${d.round}`));
    const evaluations = Object.values(g.reports);

    const players = g.players.map((p) => {
      const scores: number[] = [];
      const disputed: boolean[] = [];
      for (let r = 0; r < g.deck.length; r++) {
        if (!drawn.has(`${p.id}:${r}`)) {
          // A round with no submitted drawing can never score.
          scores.push(0);
          disputed.push(false);
          continue;
        }
        const votes: number[] = [];
        for (const ev of evaluations) {
          const v = ev[p.id]?.[r];
          if (v !== undefined) votes.push(v);
        }
        const agg = aggregateDrawing(votes);
        scores.push(agg.percent);
        disputed.push(agg.disputed);
      }
      return {
        id: p.id,
        name: p.name,
        connected: p.connected,
        scores,
        disputed,
        total: scores.reduce((a, b) => a + b, 0),
      };
    });
    const max = players.reduce((m, p) => Math.max(m, p.total), 0);
    const winners = max > 0 ? players.filter((p) => p.total === max).map((p) => p.id) : [];

    g.results = { rounds: g.deck, players, winners };
    g.phase = "results";
    this.ensureHost();
    await this.persist();
    await this.ctx.storage.deleteAlarm();
    this.broadcast({ t: "results", results: g.results, drawings: this.allDrawings() });
    this.broadcastPresence();
  }

  private async resetToLobby(): Promise<void> {
    const g = this.game;
    g.phase = "lobby";
    g.deck = [];
    g.round = -1;
    g.endsAt = 0;
    g.reports = {};
    g.results = null;
    g.players = g.players.filter((p) => p.connected);
    this.ensureHost();
    this.ctx.storage.sql.exec("DELETE FROM drawings");
    await this.persist();
    await this.ctx.storage.deleteAlarm();
    this.broadcast({ t: "lobby" });
    this.broadcastPresence();
  }

  // ------------------------------------------------------------------ helpers

  private roundStartMsg(): ServerMessage {
    const g = this.game;
    return {
      t: "roundStart",
      round: g.round,
      total: g.deck.length,
      prompt: g.deck[g.round],
      endsAt: g.endsAt,
      serverNow: Date.now(),
    };
  }

  private judgingMsg(): ServerMessage {
    const g = this.game;
    return {
      t: "judging",
      deadline: g.endsAt,
      serverNow: Date.now(),
      rounds: g.deck,
      drawings: this.allDrawings(),
    };
  }

  /** Bring a (re)connected socket up to date with the current phase. */
  private syncPhase(ws: WebSocket): void {
    const g = this.game;
    if (g.phase === "lobby") return;
    this.send(ws, { t: "gameStart", rounds: g.settings.rounds, seconds: g.settings.seconds });
    switch (g.phase) {
      case "drawing":
        this.send(ws, this.roundStartMsg());
        break;
      case "between":
        this.send(ws, { t: "roundEnd", round: g.round, nextAt: g.endsAt, serverNow: Date.now() });
        break;
      case "judging":
        this.send(ws, this.judgingMsg());
        break;
      case "results":
        if (g.results) this.send(ws, { t: "results", results: g.results, drawings: this.allDrawings() });
        break;
    }
  }

  private allDrawings(): DrawingEntry[] {
    return this.ctx.storage.sql
      .exec<DrawingRow>("SELECT player_id, round, pts FROM drawings ORDER BY round, player_id")
      .toArray()
      .map((r) => ({ playerId: r.player_id, round: r.round, pts: JSON.parse(r.pts) as DPoint[] }));
  }

  /** The host must be a connected player; hand it over when they leave. */
  private ensureHost(): void {
    const g = this.game;
    const host = g.players.find((p) => p.id === g.hostId);
    if (host?.connected) return;
    g.hostId = g.players.find((p) => p.connected)?.id ?? null;
  }

  private publicPlayers(): Player[] {
    return this.game.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected }));
  }

  private liveIds(): string[] {
    const ids: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as ConnState | null;
      if (s?.id) ids.push(s.id);
    }
    return ids;
  }

  private playerOf(ws: WebSocket): StoredPlayer | null {
    const s = ws.deserializeAttachment() as ConnState | null;
    if (!s?.id) return null;
    return this.game.players.find((p) => p.id === s.id) ?? null;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("game", this.game);
  }

  private broadcastPresence(): void {
    this.broadcast({ t: "presence", players: this.publicPlayers(), hostId: this.game.hostId });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket gone */
    }
  }

  private fail(ws: WebSocket, code: ErrorCode, message: string): void {
    this.send(ws, { t: "error", code, message });
  }

  private reject(ws: WebSocket, code: ErrorCode, message: string): void {
    this.fail(ws, code, message);
    try {
      ws.close(4003, code);
    } catch {
      /* ignore */
    }
  }

  /** Send to every joined socket (optionally except one). */
  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const s = ws.deserializeAttachment() as ConnState | null;
      if (!s?.id) continue;
      try {
        ws.send(data);
      } catch {
        /* skip dead sockets */
      }
    }
  }
}

/** Distinct random concepts for a game. */
function pickDeck(count: number): PromptRef[] {
  const pool = PROMPTS.map((p) => ({ label: p.label, pt: p.pt }));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/** Validate untrusted drawing data; returns compact, clamped points or null. */
function sanitizePoints(input: unknown): DPoint[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_DRAWING_POINTS) return null;
  const out: DPoint[] = [];
  for (const p of input) {
    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number") continue;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const x = Math.round(Math.min(1, Math.max(0, p[0])) * 10000) / 10000;
    const y = Math.round(Math.min(1, Math.max(0, p[1])) * 10000) / 10000;
    out.push([x, y, p[2] ? 1 : 0]);
  }
  return out.length > 0 ? out : null;
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
