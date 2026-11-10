import "./style.css";
import "./room.css";
import { DrawingBoard } from "./board";
import { renderDrawing } from "./drawing";
import { RoomClient, type ConnStatus } from "./net";
import { loadSettings } from "./settings";
import { MIN_PLAYERS } from "./shared/protocol";
import type {
  DPoint,
  DrawingEntry,
  Phase,
  Player,
  PromptRef,
  Results,
  ServerMessage,
} from "./shared/protocol";
import type { SketchRecognizer } from "./recognizer";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};

// ---- Lobby elements ----
const lobby = $("#lobby");
const lobbyTitle = $("#lobby-title");
const lobbySub = $("#lobby-sub");
const nameInput = $<HTMLInputElement>("#name-input");
const codeInput = $<HTMLInputElement>("#code-input");
const joinBtn = $<HTMLButtonElement>("#join-btn");
const createBtn = $<HTMLButtonElement>("#create-btn");
const joinToggle = $<HTMLButtonElement>("#join-toggle");
const joinRow = $("#join-row");
const defaultBlock = $("#default-block");
const inviteBlock = $("#invite-block");
const inviteJoinBtn = $<HTMLButtonElement>("#invite-join-btn");
const inviteCreateBtn = $<HTMLButtonElement>("#invite-create-btn");
const inviteCodeEl = $("#invite-code");
const lobbyError = $("#lobby-error");

// ---- Room elements ----
const room = $("#room");
const roomCodeEl = $("#room-code");
const copyLinkBtn = $<HTMLButtonElement>("#copy-link-btn");
const connState = $("#conn-state");
const leaveBtn = $<HTMLButtonElement>("#leave-btn");
const stage = $("#stage");
const playBar = $("#play-bar");
const mpRound = $("#mp-round");
const mpPrompt = $("#mp-prompt");
const mpTime = $("#mp-time");
const mpTimerBar = $("#mp-timer-bar");
const mpNote = $("#mp-note");
const boardFrame = $("#board-frame");
const canvas = $<HTMLCanvasElement>("#board");
const clearBtn = $<HTMLButtonElement>("#clear-btn");
const warmupNote = $("#warmup-note");
const hostPanel = $("#host-panel");
const guestNote = $("#guest-note");
const startBtn = $<HTMLButtonElement>("#start-btn");
const startHint = $("#start-hint");
const playersEl = $("#players");
const chatLog = $("#chat-log");
const chatInput = $<HTMLInputElement>("#chat-input");
const chatForm = $<HTMLFormElement>("#chat-form");
const judgingView = $("#judging-view");
const judgingText = $("#judging-text");
const resultsView = $("#results-view");
const resultsTitle = $("#results-title");
const resultsTable = $("#results-table");
const resultsGallery = $("#results-gallery");
const resultsNote = $("#results-note");
const againBtn = $<HTMLButtonElement>("#again-btn");
const againNote = $("#again-note");

// ---- Constants ----
/** Fixed brush: the thickness changes what the AI sees, so everyone uses the same. */
const GAME_BRUSH_PX = 14;
const BOARD_PX = 420;
/**
 * Coordinates are sent with 4 decimals (~0.04px on the 420px board). With 3
 * decimals the AI's score for the replayed drawing drifted up to ~14 points
 * from the live one on wobbly strokes; with 4 it stays within ~2 points.
 */
const COORD_SCALE = 10000;
const MAX_POINTS = 4000;
const THUMB_PX = 210;

// ---- State ----
let board: DrawingBoard | null = null;
let client: RoomClient | null = null;
let recognizerPromise: Promise<SketchRecognizer> | null = null;

let selfId = "";
let hostId: string | null = null;
let players: Player[] = [];
let phase: Phase = "lobby";

let inGame = false;
let settings = { rounds: 6, seconds: 20 };
let clockOffset = 0; // server clock - local clock
let round = -1;
let shownRound = -2; // round currently on the board (to keep a drawing across reconnects)
let totalRounds = 0;
let roundEndsAt = 0;
let nextAt = 0;
let currentPts: DPoint[] = [];
let myDrawings: DPoint[][] = [];
const submitted = new Set<number>();
const acked = new Set<number>();
let computedScores: Record<string, number[]> | null = null;
let ticker: number | null = null;

const serverNow = (): number => Date.now() + clockOffset;
const roundCoord = (v: number): number => Math.round(v * COORD_SCALE) / COORD_SCALE;

// ---- Small DOM helpers ----
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function showError(msg: string): void {
  lobbyError.textContent = msg;
}

function addChat(name: string, text: string, self = false): void {
  const li = el("li", "chat-msg" + (self ? " chat-msg--self" : ""));
  li.append(el("span", "chat-msg__name", name), document.createTextNode(` ${text}`));
  chatLog.appendChild(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addSystem(text: string): void {
  chatLog.appendChild(el("li", "chat-msg chat-msg--system", text));
  chatLog.scrollTop = chatLog.scrollHeight;
}

function randomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ---- The AI (loaded on demand: only needed to judge) ----
function getRecognizer(): Promise<SketchRecognizer> {
  if (!recognizerPromise) {
    recognizerPromise = import("./recognizer")
      .then(async (m) => {
        const r = new m.SketchRecognizer();
        await r.load();
        return r;
      })
      .catch((err) => {
        recognizerPromise = null; // allow a retry
        throw err;
      });
  }
  return recognizerPromise;
}

// ---- Rendering: players, host area ----
function connectedCount(): number {
  return players.filter((p) => p.connected !== false).length;
}

function renderPlayers(): void {
  playersEl.replaceChildren(
    ...players.map((p) => {
      const off = p.connected === false;
      const li = el(
        "li",
        "player" + (p.id === selfId ? " player--self" : "") + (off ? " player--off" : ""),
      );
      li.append(document.createTextNode(p.name));
      if (p.id === hostId) li.append(el("span", "player__tag", "anfitrião"));
      if (off) li.append(el("span", "player__tag", "desconectado"));
      return li;
    }),
  );
}

function renderHostArea(): void {
  const waiting = phase === "lobby";
  const amHost = hostId !== null && hostId === selfId;
  hostPanel.hidden = !(waiting && amHost);
  guestNote.hidden = !(waiting && !amHost);
  if (waiting && amHost) {
    const n = connectedCount();
    startBtn.disabled = n < MIN_PLAYERS;
    startHint.textContent =
      n < MIN_PLAYERS
        ? `Aguardando pelo menos ${MIN_PLAYERS} jogadores (${n} na sala). Use "Copiar convite".`
        : `${n} jogadores na sala.`;
  }
  if (phase === "results") {
    againBtn.hidden = !amHost;
    againNote.hidden = amHost;
  }
}

function showPhase(p: Phase): void {
  phase = p;
  const inStage = p === "lobby" || p === "drawing" || p === "between";
  stage.hidden = !inStage;
  judgingView.hidden = p !== "judging";
  resultsView.hidden = p !== "results";
  playBar.hidden = !(p === "drawing" || p === "between");
  warmupNote.hidden = p !== "lobby";
  stage.classList.toggle("stage--waiting", p === "lobby");
  boardFrame.classList.toggle("board-frame--locked", p === "between");
  // Shared warm-up in the lobby; private and time-locked while playing.
  board?.setEnabled(p === "lobby" || (p === "drawing" && serverNow() < roundEndsAt));
  renderHostArea();
}

// ---- Drawing rounds ----
function record(nx: number, ny: number, isStart: boolean): void {
  if (currentPts.length >= MAX_POINTS) {
    board?.setEnabled(false);
    mpNote.textContent = "Limite de traço atingido neste desenho.";
    return;
  }
  const x = roundCoord(nx);
  const y = roundCoord(ny);
  if (!isStart) {
    // Only exact repeats are dropped: any other filtering bends the stroke
    // and would change the score the AI gives the replayed drawing.
    const last = currentPts[currentPts.length - 1];
    if (last && last[0] === x && last[1] === y) return;
  }
  currentPts.push([x, y, isStart ? 1 : 0]);
}

function lockAndSubmit(): void {
  board?.setEnabled(false);
  submitted.add(round);
  myDrawings[round] = currentPts.slice();
  if (currentPts.length > 0) {
    client?.sendDrawing(round, myDrawings[round]);
  } else {
    mpNote.textContent = "Você não desenhou nada neste desenho.";
  }
}

function startTicker(): void {
  if (ticker === null) ticker = window.setInterval(tick, 150);
  tick();
}

function stopTicker(): void {
  if (ticker !== null) window.clearInterval(ticker);
  ticker = null;
}

function tick(): void {
  const now = serverNow();
  if (phase === "drawing") {
    const left = roundEndsAt - now;
    mpTime.textContent = `${Math.max(0, Math.ceil(left / 1000))}s`;
    mpTimerBar.style.width = `${Math.max(0, Math.min(100, (left / (settings.seconds * 1000)) * 100))}%`;
    mpTimerBar.classList.toggle("timer-bar--low", left <= 5000);
    if (left <= 0 && !submitted.has(round)) lockAndSubmit();
  } else if (phase === "between") {
    mpTime.textContent = "0s";
    mpTimerBar.style.width = "0%";
    const left = Math.max(0, Math.ceil((nextAt - now) / 1000));
    const last = round + 1 >= totalRounds;
    const sent = acked.has(round) ? "Desenho enviado. " : "";
    mpNote.textContent = last
      ? `${sent}A IA vai avaliar os desenhos em ${left}s…`
      : `${sent}Próximo conceito em ${left}s…`;
  } else {
    stopTicker();
  }
}

// ---- Judging: the local AI scores EVERY drawing (cross-verification) ----
// The server keeps the median of everyone's evaluations, so no single browser
// decides a score. Each drawing is replayed from the server's copy, which is
// the same data for all evaluators.
async function evaluate(rounds: PromptRef[], drawings: DrawingEntry[]): Promise<void> {
  if (computedScores) {
    client?.sendScores(computedScores); // re-send after a reconnect; the server ignores repeats
    return;
  }
  const out: Record<string, number[]> = {};
  try {
    const rec = await getRecognizer();
    const off = document.createElement("canvas");
    off.width = BOARD_PX;
    off.height = BOARD_PX;
    let done = 0;
    for (const d of drawings) {
      const concept = rounds[d.round];
      if (!concept) continue;
      renderDrawing(off, d.pts, GAME_BRUSH_PX);
      (out[d.playerId] ??= rounds.map(() => 0))[d.round] = rec.scoreFor(off, concept.label);
      // Let the page breathe so the spinner keeps moving on long games.
      if (++done % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  } catch (err) {
    // Abstain (empty report) instead of voting zeros: a browser that cannot run
    // the AI must not drag down other people's scores.
    console.error(err);
    judgingText.textContent =
      "Não foi possível carregar a IA neste navegador. As notas virão dos outros jogadores.";
    for (const k of Object.keys(out)) delete out[k];
  }
  computedScores = out;
  client?.sendScores(out);
}

// ---- Results ----
/** "62%", with a trailing * when the players' browsers disagreed on this score. */
function pctLabel(score: number, disputed?: boolean): string {
  return `${score}%${disputed ? "*" : ""}`;
}

function renderResults(res: Results, drawings: DrawingEntry[]): void {
  const label = (id: string): string => (id === selfId ? "Você" : (res.players.find((p) => p.id === id)?.name ?? "?"));

  if (res.winners.length === 0) {
    resultsTitle.textContent = "Ninguém pontuou desta vez.";
  } else if (res.winners.length === 1) {
    resultsTitle.textContent =
      res.winners[0] === selfId ? "Você venceu!" : `${label(res.winners[0])} venceu!`;
  } else {
    resultsTitle.textContent = `Empate: ${res.winners.map(label).join(", ")}`;
  }

  const ranked = [...res.players].sort((a, b) => b.total - a.total);
  resultsNote.hidden = !res.players.some((p) => p.disputed?.some(Boolean));

  // Ranking table
  const head = el("tr");
  // Total sits right after the name so it is always visible; the per-drawing
  // columns can scroll sideways on narrow screens.
  head.append(el("th", "", "#"), el("th", "", "Jogador"), el("th", "results__num", "Total"));
  res.rounds.forEach((r, i) => {
    const th = el("th", "results__num", `${i + 1}`);
    th.title = r.pt;
    head.append(th);
  });
  const rows = ranked.map((p, i) => {
    const tr = el(
      "tr",
      (res.winners.includes(p.id) ? "results__row--win " : "") + (p.id === selfId ? "results__row--me" : ""),
    );
    tr.append(
      el("td", "", `${i + 1}`),
      el("td", "", p.id === selfId ? `${p.name} (você)` : p.name),
      el("td", "results__num results__total", `${p.total}`),
    );
    p.scores.forEach((s, r) => tr.append(el("td", "results__num", pctLabel(s, p.disputed?.[r]))));
    return tr;
  });
  resultsTable.replaceChildren(head, ...rows);

  // Gallery: for each concept, every player's drawing with the AI's percentage
  const byKey = new Map<string, DrawingEntry>();
  for (const d of drawings) byKey.set(`${d.playerId}:${d.round}`, d);

  const sections = res.rounds.map((r, i) => {
    const section = el("section", "gallery__round");
    section.append(el("h4", "gallery__concept", `${i + 1}. ${r.pt}`));
    const row = el("div", "gallery__row");
    for (const p of ranked) {
      const card = el("figure", "gallery__card");
      const d = byKey.get(`${p.id}:${i}`);
      if (d) {
        const c = el("canvas", "gallery__thumb");
        c.width = THUMB_PX;
        c.height = THUMB_PX;
        renderDrawing(c, d.pts, (GAME_BRUSH_PX * THUMB_PX) / BOARD_PX);
        c.setAttribute("aria-label", `Desenho de ${p.name}: ${r.pt}`);
        card.append(c);
      } else {
        card.append(el("div", "gallery__empty", "sem desenho"));
      }
      const cap = el("figcaption", "gallery__caption");
      cap.append(
        el("span", "gallery__name", p.id === selfId ? "Você" : p.name),
        el("strong", "", pctLabel(p.scores[i] ?? 0, p.disputed?.[i])),
      );
      card.append(cap);
      row.append(card);
    }
    section.append(row);
    return section;
  });
  resultsGallery.replaceChildren(...sections);
  renderHostArea();
}

// ---- Server messages ----
function onMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case "welcome": {
      selfId = msg.selfId;
      hostId = msg.hostId;
      players = msg.players;
      renderPlayers();
      if (msg.phase === "lobby") {
        resetGame();
        showPhase("lobby");
        addSystem(`Você entrou na sala ${roomCodeEl.textContent}.`);
      } else {
        addSystem("Você voltou para a partida em andamento.");
      }
      break;
    }
    case "presence":
      players = msg.players;
      hostId = msg.hostId;
      renderPlayers();
      renderHostArea();
      break;
    case "gameStart": {
      settings = { rounds: msg.rounds, seconds: msg.seconds };
      if (!inGame) {
        inGame = true;
        myDrawings = [];
        submitted.clear();
        acked.clear();
        computedScores = null;
        shownRound = -2;
        board?.clear();
      }
      void getRecognizer().catch(() => {}); // warm up; it is needed when judging
      break;
    }
    case "roundStart": {
      clockOffset = msg.serverNow - Date.now();
      round = msg.round;
      totalRounds = msg.total;
      roundEndsAt = msg.endsAt;
      if (shownRound !== msg.round) {
        // A new concept (a reconnect during the same round keeps the drawing).
        shownRound = msg.round;
        currentPts = [];
        board?.clear();
        mpNote.textContent = "";
      }
      mpRound.textContent = `Desenho ${msg.round + 1}/${msg.total}`;
      mpPrompt.textContent = msg.prompt.pt;
      showPhase("drawing");
      startTicker();
      break;
    }
    case "roundEnd": {
      clockOffset = msg.serverNow - Date.now();
      round = msg.round;
      nextAt = msg.nextAt;
      if (!submitted.has(round)) lockAndSubmit();
      else if (currentPts.length > 0 && !acked.has(round)) client?.sendDrawing(round, myDrawings[round]);
      showPhase("between");
      startTicker();
      break;
    }
    case "drawingAck":
      acked.add(msg.round);
      break;
    case "judging":
      clockOffset = msg.serverNow - Date.now();
      stopTicker();
      showPhase("judging");
      void evaluate(msg.rounds, msg.drawings);
      break;
    case "results":
      stopTicker();
      showPhase("results");
      renderResults(msg.results, msg.drawings);
      break;
    case "lobby":
      resetGame();
      showPhase("lobby");
      addSystem("De volta ao lobby. O anfitrião pode iniciar outra partida.");
      break;
    case "stroke":
      if (phase === "lobby") {
        for (const p of msg.stroke.points) board?.drawRemoteSegment(msg.from, p.x, p.y, !!p.s);
      }
      break;
    case "clear":
      if (phase === "lobby") {
        board?.clear();
        board?.resetRemote(msg.from);
      }
      break;
    case "chat":
      addChat(msg.name, msg.text, msg.from === selfId);
      break;
    case "error":
      if (msg.code === "in_progress" || msg.code === "room_full") backToLobby(msg.message);
      else addSystem(msg.message);
      break;
  }
}

/** Forget everything about the previous game. */
function resetGame(): void {
  inGame = false;
  round = -1;
  shownRound = -2;
  currentPts = [];
  myDrawings = [];
  submitted.clear();
  acked.clear();
  computedScores = null;
  stopTicker();
  board?.clear();
  mpTimerBar.style.width = "100%";
  mpTimerBar.classList.remove("timer-bar--low");
}

const STATUS_LABEL: Record<ConnStatus, string> = {
  connecting: "conectando…",
  open: "conectado",
  reconnecting: "reconectando…",
  closed: "desconectado",
};

function onStatus(s: ConnStatus): void {
  if (!client) return;
  connState.textContent = STATUS_LABEL[s];
}

/** The server refused us (room full / game running): go back to the lobby form. */
function backToLobby(message: string): void {
  client?.close();
  client = null;
  stopTicker();
  room.hidden = true;
  lobby.hidden = false;
  history.replaceState(null, "", "/room");
  showError(message);
}

// ---- Entering a room ----
function enterRoom(code: string, name: string): void {
  lobby.hidden = true;
  room.hidden = false;
  roomCodeEl.textContent = code;
  connState.textContent = STATUS_LABEL.connecting;
  history.replaceState(null, "", `/room?room=${encodeURIComponent(code)}`); // a reload rejoins through the invite flow

  board = new DrawingBoard(canvas);
  board.setBrushSize(GAME_BRUSH_PX);
  board.setOnSegment((nx, ny, isStart) => {
    if (phase === "lobby") client?.sendPoint(nx, ny, isStart);
    else if (phase === "drawing") record(nx, ny, isStart);
  });

  client = new RoomClient(code, name, { onMessage, onStatus });
  client.connect();
}

// ---- Lobby actions ----
/** Validate the name, persist it, and return it — or null (with an error shown). */
function requireName(): string | null {
  const name = nameInput.value.trim();
  if (!name) {
    showError("Digite seu nome.");
    nameInput.focus();
    return null;
  }
  try {
    localStorage.setItem("adivinhia.name", name);
  } catch {
    /* ignore */
  }
  return name;
}

/** Create a brand-new room: only the name is needed, the code is generated. */
function createRoom(): void {
  const name = requireName();
  if (!name) return;
  enterRoom(randomCode(), name);
}

/** Join an existing room by its code. */
function joinRoom(): void {
  const name = requireName();
  if (!name) return;
  const clean = codeInput.value.trim().toUpperCase();
  if (!clean) {
    showError("Digite o código da sala para entrar.");
    codeInput.focus();
    return;
  }
  if (!CODE_RE.test(clean)) {
    showError("Código inválido.");
    return;
  }
  enterRoom(clean, name);
}

joinBtn.addEventListener("click", joinRoom);
createBtn.addEventListener("click", createRoom);
codeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoom();
});

// The code field stays hidden until the player says they have a code.
joinToggle.addEventListener("click", () => {
  const open = joinRow.hidden;
  joinRow.hidden = !open;
  joinToggle.setAttribute("aria-expanded", String(open));
  showError("");
  if (open) codeInput.focus();
});

// ---- Invite link flow (?room=CODE): no code field needed ----
const CODE_RE = /^[A-Z0-9_-]{1,32}$/;
let inviteCode: string | null = null;

function enableInviteMode(code: string): void {
  inviteCode = code;
  inviteCodeEl.textContent = code;
  lobbyTitle.textContent = "Você foi convidado";
  lobbySub.textContent = "Digite seu nome para entrar na sala.";
  defaultBlock.hidden = true;
  inviteBlock.hidden = false;
}

inviteJoinBtn.addEventListener("click", () => {
  const name = requireName();
  if (name && inviteCode) enterRoom(inviteCode, name);
});
inviteCreateBtn.addEventListener("click", createRoom);

// ---- Room controls ----
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for contexts where the async clipboard API is unavailable.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

copyLinkBtn.addEventListener("click", async () => {
  const code = roomCodeEl.textContent ?? "";
  const url = `${location.origin}/room?room=${encodeURIComponent(code)}`;
  const ok = await copyText(url);
  const original = "Copiar convite";
  copyLinkBtn.textContent = ok ? "Link copiado" : "Não foi possível copiar";
  if (!ok) window.prompt("Copie o link de convite:", url);
  window.setTimeout(() => (copyLinkBtn.textContent = original), 2000);
});

clearBtn.addEventListener("click", () => {
  if (phase === "lobby") {
    board?.clear();
    client?.sendClear();
  } else if (phase === "drawing" && !submitted.has(round)) {
    board?.clear();
    currentPts = [];
    board?.setEnabled(serverNow() < roundEndsAt);
  }
});

leaveBtn.addEventListener("click", () => {
  client?.close();
  location.assign("/room");
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  client?.sendChat(text);
  chatInput.value = "";
});

// Host: pick the settings and start
const checkedValue = (name: string): number =>
  Number(document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value);

startBtn.addEventListener("click", () => {
  client?.sendStart(checkedValue("mp-rounds"), checkedValue("mp-seconds"));
});

againBtn.addEventListener("click", () => client?.sendPlayAgain());

// ---- Boot ----
// Default the host's choices to the solo settings.
const saved = loadSettings();
for (const [name, value] of [
  ["mp-rounds", saved.rounds],
  ["mp-seconds", saved.seconds],
] as const) {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

try {
  const savedName = localStorage.getItem("adivinhia.name");
  if (savedName) nameInput.value = savedName;
} catch {
  /* ignore */
}
const urlCode = (new URLSearchParams(location.search).get("room") ?? "").trim().toUpperCase();
if (CODE_RE.test(urlCode)) enableInviteMode(urlCode);
