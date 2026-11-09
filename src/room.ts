import "./style.css";
import "./room.css";
import { DrawingBoard } from "./board";
import { RoomClient } from "./net";
import type { Player } from "./shared/protocol";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};

// Lobby elements
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

// Room elements
const room = $("#room");
const roomCodeEl = $("#room-code");
const copyLinkBtn = $<HTMLButtonElement>("#copy-link-btn");
const playersEl = $("#players");
const canvas = $<HTMLCanvasElement>("#board");
const clearBtn = $<HTMLButtonElement>("#clear-btn");
const leaveBtn = $<HTMLButtonElement>("#leave-btn");
const chatLog = $("#chat-log");
const chatInput = $<HTMLInputElement>("#chat-input");
const chatForm = $<HTMLFormElement>("#chat-form");
const connState = $("#conn-state");

let board: DrawingBoard | null = null;
let client: RoomClient | null = null;

function randomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function showError(msg: string): void {
  lobbyError.textContent = msg;
}

function renderPlayers(players: Player[]): void {
  playersEl.innerHTML = players
    .map(
      (p) =>
        `<li class="player${p.id === client?.selfId ? " player--self" : ""}">${escapeHtml(p.name)}</li>`,
    )
    .join("");
}

function addChat(name: string, text: string, self = false): void {
  const li = document.createElement("li");
  li.className = "chat-msg" + (self ? " chat-msg--self" : "");
  li.innerHTML = `<span class="chat-msg__name">${escapeHtml(name)}</span> ${escapeHtml(text)}`;
  chatLog.appendChild(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addSystem(text: string): void {
  const li = document.createElement("li");
  li.className = "chat-msg chat-msg--system";
  li.textContent = text;
  chatLog.appendChild(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function enterRoom(code: string, name: string): void {
  lobby.hidden = true;
  room.hidden = false;
  roomCodeEl.textContent = code;
  connState.textContent = "conectando…";

  board = new DrawingBoard(canvas);
  client = new RoomClient(code, name, {
    onOpen: () => (connState.textContent = "conectado"),
    onClose: () => (connState.textContent = "desconectado"),
    onWelcome: (_selfId, players) => {
      renderPlayers(players);
      addSystem(`Você entrou na sala ${code}.`);
    },
    onPresence: (players) => renderPlayers(players),
    onStroke: (from, stroke) => {
      for (const p of stroke.points) {
        board!.drawRemoteSegment(from, p.x, p.y, !!p.s);
      }
    },
    onClear: (from) => {
      board!.clear();
      board!.resetRemote(from);
    },
    onChat: (from, cname, text) => addChat(cname, text, from === client?.selfId),
  });

  // Stream local drawing to peers.
  board.setOnSegment((nx, ny, isStart) => client!.sendPoint(nx, ny, isStart));
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
  if (!/^[A-Z0-9_-]{1,32}$/.test(clean)) {
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

// ---- Copy the invite link from inside the room ----
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
  board?.clear();
  client?.sendClear();
});

leaveBtn.addEventListener("click", () => {
  client?.close();
  location.reload();
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  client?.sendChat(text);
  chatInput.value = "";
});

// Prefill the saved name; an invite link (?room=CODE) switches to invite mode.
try {
  const savedName = localStorage.getItem("adivinhia.name");
  if (savedName) nameInput.value = savedName;
} catch {
  /* ignore */
}
const urlCode = (new URLSearchParams(location.search).get("room") ?? "").trim().toUpperCase();
if (CODE_RE.test(urlCode)) enableInviteMode(urlCode);
