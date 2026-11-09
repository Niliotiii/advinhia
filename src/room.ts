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
const nameInput = $<HTMLInputElement>("#name-input");
const codeInput = $<HTMLInputElement>("#code-input");
const joinBtn = $<HTMLButtonElement>("#join-btn");
const createBtn = $<HTMLButtonElement>("#create-btn");
const lobbyError = $("#lobby-error");

// Room elements
const room = $("#room");
const roomCodeEl = $("#room-code");
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

// Prefill name + code from storage / URL (?room=CODE).
try {
  const savedName = localStorage.getItem("adivinhia.name");
  if (savedName) nameInput.value = savedName;
} catch {
  /* ignore */
}
const urlCode = new URLSearchParams(location.search).get("room");
if (urlCode) codeInput.value = urlCode.toUpperCase();
