import "./style.css";
import { SketchRecognizer, type Prediction } from "./recognizer";
import { DrawingBoard } from "./board";
import { renderForAI } from "./drawing";
import { Game, type GameSnapshot, type RoundResult } from "./game";
import {
  BRUSH_PX,
  DEFAULT_SETTINGS,
  loadName,
  loadSettings,
  saveName,
  saveSettings,
  type Settings,
} from "./settings";

// ---- DOM references ----
const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};

const appEl = $("#app");
const canvas = $<HTMLCanvasElement>("#board");
const promptEl = $("#prompt");
const hintEl = $("#hint");
const timerEl = $("#timer");
const timerBar = $("#timer-bar");
const scoreEl = $("#score");
const bestEl = $("#best");
const roundEl = $("#round");
const guessesEl = $("#guesses");
const visionCanvas = $<HTMLCanvasElement>("#vision");
const statusEl = $("#status");
const overlay = $("#overlay");
const overlayTitle = $("#overlay-title");
const overlayText = $("#overlay-text");
const overlayBtn = $<HTMLButtonElement>("#overlay-btn");
const overlayMenuBtn = $<HTMLButtonElement>("#overlay-menu-btn");
const clearBtn = $<HTMLButtonElement>("#clear-btn");
const skipBtn = $<HTMLButtonElement>("#skip-btn");
const menuBtn = $<HTMLButtonElement>("#menu-btn");
const playSoloBtn = $<HTMLButtonElement>("#play-solo-btn");
const settingsToggle = $<HTMLButtonElement>("#settings-toggle");
const settingsPanel = $("#settings");
const settingsReset = $<HTMLButtonElement>("#settings-reset");
const nameSetting = $<HTMLInputElement>("#name-setting");

// ---- Core objects ----
const recognizer = new SketchRecognizer();
const board = new DrawingBoard(canvas);
const game = new Game();
// What the AI is shown: the board's strokes re-rendered in black with an ideal,
// size-proportional width (the player's brush and colours are only cosmetic).
const aiCanvas = document.createElement("canvas");
aiCanvas.width = canvas.width;
aiCanvas.height = canvas.height;
let settings: Settings = loadSettings();

// Tracks the current round's prompt so we can detect when a new round begins.
let lastPrompt: string | null = null;

// ---- Inference loop (local, runs in the browser) ----
// We poll the canvas on a fixed interval instead of per-frame. This is the
// key latency/bandwidth decision: inference is cheap and local, but there is
// no reason to run it faster than a human can draw. ~250ms feels real-time.
const INFERENCE_INTERVAL_MS = 250;
let inferenceTimer: number | null = null;

function startInferenceLoop(): void {
  stopInferenceLoop();
  inferenceTimer = window.setInterval(runInference, INFERENCE_INTERVAL_MS);
}
function stopInferenceLoop(): void {
  if (inferenceTimer !== null) {
    window.clearInterval(inferenceTimer);
    inferenceTimer = null;
  }
}

function runInference(): void {
  if (!recognizer.isReady() || !game.isPlaying() || !board.dirty) return;

  renderForAI(aiCanvas, board.getStrokes());
  const predictions = recognizer.predict(aiCanvas, 5);
  renderGuesses(predictions);
  renderVision();

  const won = game.submitGuesses(predictions);
  if (won) {
    stopInferenceLoop();
    celebrate();
  }
}

// Draw the exact 28x28 normalized tensor the model receives, scaled up with
// nearest-neighbor so the player can see "what the AI sees".
function renderVision(): void {
  const input = recognizer.getLastInput();
  const vctx = visionCanvas.getContext("2d");
  if (!vctx) return;
  if (!input) {
    vctx.clearRect(0, 0, 28, 28);
    return;
  }
  const img = vctx.createImageData(28, 28);
  for (let p = 0; p < 28 * 28; p++) {
    // input is bright-stroke-on-dark in [0,1]; show it that way (white ink).
    const v = Math.round(input[p] * 255);
    img.data[p * 4] = v;
    img.data[p * 4 + 1] = v;
    img.data[p * 4 + 2] = v;
    img.data[p * 4 + 3] = 255;
  }
  vctx.putImageData(img, 0, 0);
}

// Brief celebratory burst when the AI locks in the correct guess.
function celebrate(): void {
  const colors = ["#e8613c", "#2f8f6b", "#1b1a17", "#f4b840"];
  const n = 18;
  for (let i = 0; i < n; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti";
    piece.style.left = "50%";
    piece.style.top = "40%";
    piece.style.background = colors[i % colors.length];
    const angle = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const dist = 120 + Math.random() * 120;
    piece.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    piece.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
    piece.style.animationDelay = `${Math.random() * 60}ms`;
    document.body.appendChild(piece);
    piece.addEventListener("animationend", () => piece.remove());
  }
}

// ---- Rendering ----
function renderGuesses(predictions: Prediction[]): void {
  const target = game.currentPrompt?.label;
  guessesEl.innerHTML = predictions
    .map((p) => {
      const pct = Math.round(p.probability * 100);
      const hit = p.label === target ? " guess--hit" : "";
      return `
        <li class="guess${hit}">
          <span class="guess__label">${formatLabel(p.label)}</span>
          <span class="guess__bar"><span style="width:${pct}%"></span></span>
          <span class="guess__pct">${pct}%</span>
        </li>`;
    })
    .join("");
}

function formatLabel(label: string): string {
  return label.replace(/_/g, " ");
}

function renderSnapshot(s: GameSnapshot): void {
  scoreEl.textContent = String(s.score);
  bestEl.textContent = String(s.bestScore);
  roundEl.textContent = `${s.round}/${s.totalRounds}`;
  timerEl.textContent = `${s.timeLeft}s`;
  const pct = (s.timeLeft / s.roundDuration) * 100;
  timerBar.style.width = `${pct}%`;
  timerBar.classList.toggle("timer-bar--low", s.timeLeft <= 5);

  if (s.phase === "playing" && s.prompt) {
    promptEl.textContent = s.prompt.pt;
    hintEl.textContent = s.hint;
  }
}

// ---- Round / game outcome overlays ----
function showRoundResult(r: RoundResult): void {
  stopInferenceLoop();
  if (r.won) {
    overlayTitle.textContent = "A IA adivinhou!";
    overlayText.innerHTML = `Você desenhou <strong>${r.prompt.pt}</strong> e ganhou <strong>${r.pointsEarned}</strong> pontos (${r.timeLeft}s restantes).`;
  } else {
    overlayTitle.textContent = "Tempo esgotado";
    overlayText.innerHTML = `Era <strong>${r.prompt.pt}</strong>. A IA não conseguiu adivinhar dessa vez.`;
  }
  overlayBtn.textContent = "Próxima rodada";
  overlayMenuBtn.hidden = true;
  overlayBtn.onclick = () => {
    hideOverlay();
    game.advance();
  };
  showOverlay();
}

function showGameOver(s: GameSnapshot): void {
  stopInferenceLoop();
  overlayTitle.textContent = "Fim de jogo!";
  if (s.isNewBest) {
    overlayText.innerHTML = `Novo recorde: <strong>${s.score}</strong> pontos!`;
    celebrate();
  } else {
    overlayText.innerHTML = `Pontuação final: <strong>${s.score}</strong> pontos.<br />Seu recorde: <strong>${s.bestScore}</strong>.`;
  }
  overlayBtn.textContent = "Jogar de novo";
  overlayMenuBtn.hidden = false;
  overlayMenuBtn.onclick = goToMenu;
  overlayBtn.onclick = () => {
    hideOverlay();
    lastPrompt = null;
    game.start();
  };
  showOverlay();
}

function showOverlay(): void {
  overlay.classList.add("overlay--visible");
}
function hideOverlay(): void {
  overlay.classList.remove("overlay--visible");
}

// ---- Round lifecycle hooks ----
function beginRound(): void {
  board.clear();
  guessesEl.innerHTML = "";
  recognizer.reset();
  renderVision();
  startInferenceLoop();
}

// Single update handler. We detect a new round by watching for a change in
// the current prompt while in the "playing" phase, and reset the board then.
game.setOnUpdate((s) => {
  renderSnapshot(s);
  if (s.phase === "playing" && s.prompt && s.prompt.label !== lastPrompt) {
    lastPrompt = s.prompt.label;
    beginRound();
  } else if (s.phase === "gameOver") {
    lastPrompt = null;
    showGameOver(s);
  }
});

game.setOnRoundEnd((r) => {
  showRoundResult(r);
});

// ---- Controls ----
clearBtn.addEventListener("click", () => {
  board.clear();
  guessesEl.innerHTML = "";
  recognizer.reset();
  renderVision();
});
skipBtn.addEventListener("click", () => game.skip());
menuBtn.addEventListener("click", goToMenu);

// ---- Views: menu <-> game ----
function setView(view: "menu" | "game"): void {
  appEl.dataset.view = view;
  window.scrollTo(0, 0);
}

function startSolo(): void {
  if (!recognizer.isReady()) return;
  game.configure(settings);
  board.setBrushSize(BRUSH_PX[settings.brush]);
  board.clear();
  hideOverlay();
  lastPrompt = null;
  setView("game");
  game.start();
}

function goToMenu(): void {
  stopInferenceLoop();
  game.abort();
  hideOverlay();
  lastPrompt = null;
  setView("menu");
}

playSoloBtn.addEventListener("click", startSolo);

// ---- Settings ----
function syncSettingsForm(): void {
  const current: Record<string, string> = {
    rounds: String(settings.rounds),
    seconds: String(settings.seconds),
    difficulty: settings.difficulty,
    hints: String(settings.hints),
    brush: settings.brush,
  };
  for (const [name, value] of Object.entries(current)) {
    const input = settingsPanel.querySelector<HTMLInputElement>(
      `input[name="${name}"][value="${value}"]`,
    );
    if (input) input.checked = true;
  }
  nameSetting.value = loadName();
}

settingsPanel.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  if (input.type !== "radio") return;
  // Values come from our own radio buttons, so the casts are safe.
  switch (input.name) {
    case "rounds":
      settings.rounds = Number(input.value) as Settings["rounds"];
      break;
    case "seconds":
      settings.seconds = Number(input.value) as Settings["seconds"];
      break;
    case "difficulty":
      settings.difficulty = input.value as Settings["difficulty"];
      break;
    case "hints":
      settings.hints = input.value === "true";
      break;
    case "brush":
      settings.brush = input.value as Settings["brush"];
      break;
  }
  saveSettings(settings);
});

nameSetting.addEventListener("input", () => saveName(nameSetting.value));

settingsReset.addEventListener("click", () => {
  settings = { ...DEFAULT_SETTINGS };
  saveSettings(settings);
  syncSettingsForm();
});

settingsToggle.addEventListener("click", () => {
  const open = settingsPanel.hidden;
  settingsPanel.hidden = !open;
  settingsToggle.setAttribute("aria-expanded", String(open));
});

syncSettingsForm();

// ---- Boot ----
// The menu is the first screen. The model loads in the background while the
// player browses it; solo mode unlocks as soon as inference is ready.
async function boot(): Promise<void> {
  setView("menu");
  playSoloBtn.disabled = true;
  playSoloBtn.textContent = "Carregando modelo…";

  try {
    await recognizer.load();
    statusEl.textContent = "";
    playSoloBtn.disabled = false;
    playSoloBtn.textContent = "Jogar solo";
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Não foi possível carregar o modelo de IA.";
    playSoloBtn.disabled = false;
    playSoloBtn.textContent = "Tentar de novo";
    playSoloBtn.onclick = () => location.reload();
  }
}

boot();

// ---- PWA: register the service worker for offline play ----
// Once the app shell + model are cached, the game runs fully offline — which
// fits the whole design: inference is local, so no network is needed to play.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
