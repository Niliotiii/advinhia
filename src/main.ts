import "./style.css";
import { SketchRecognizer, type Prediction } from "./recognizer";
import { DrawingBoard } from "./board";
import { Game, type GameSnapshot, type RoundResult } from "./game";

// ---- DOM references ----
const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};

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
const clearBtn = $<HTMLButtonElement>("#clear-btn");
const skipBtn = $<HTMLButtonElement>("#skip-btn");

// ---- Core objects ----
const recognizer = new SketchRecognizer();
const board = new DrawingBoard(canvas);
const game = new Game();

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

  const predictions = recognizer.predict(canvas, 5);
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

// ---- Boot ----
async function boot(): Promise<void> {
  statusEl.textContent = "Carregando modelo de IA (local)…";
  overlayTitle.innerHTML = 'Adivinh<span class="logo__ai">IA</span>';
  overlayText.innerHTML =
    "Desenhe o conceito mostrado. Uma IA de visão computacional roda <strong>localmente no seu navegador</strong> e tenta adivinhar em tempo real. Quanto mais rápido ela acertar, mais pontos você faz!";
  overlayBtn.textContent = "Carregando…";
  overlayBtn.disabled = true;
  showOverlay();

  try {
    await recognizer.load();
    statusEl.textContent = "";
    renderSnapshot(game.snapshot());
    overlayBtn.textContent = "Começar a jogar";
    overlayBtn.disabled = false;
    overlayBtn.onclick = () => {
      hideOverlay();
      game.start();
    };
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Falha ao carregar o modelo.";
    overlayText.textContent =
      "Não foi possível carregar o modelo de IA. Recarregue a página.";
    overlayBtn.textContent = "Recarregar";
    overlayBtn.disabled = false;
    overlayBtn.onclick = () => location.reload();
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
