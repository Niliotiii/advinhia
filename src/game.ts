import { PROMPTS, type Prompt } from "./shared/prompts";
import {
  CONFIDENCE_BY_DIFFICULTY,
  DEFAULT_SETTINGS,
  isDefaultSettings,
  type Settings,
} from "./settings";

export type GamePhase = "idle" | "playing" | "roundWon" | "roundLost" | "gameOver";

export interface RoundResult {
  prompt: Prompt;
  won: boolean;
  pointsEarned: number;
  timeLeft: number;
}

export interface GameSnapshot {
  phase: GamePhase;
  round: number;
  totalRounds: number;
  score: number;
  prompt: Prompt | null;
  timeLeft: number;
  roundDuration: number;
  /** Partially-revealed version of the prompt word, e.g. "m _ ç _". */
  hint: string;
  /** Best score for the current settings (persisted in localStorage). */
  bestScore: number;
  /** True at game over if this run beat the stored best score. */
  isNewBest: boolean;
}

// Pre-settings versions stored a single best score; it corresponds to the
// default configuration, so we keep honoring it for that configuration.
const LEGACY_BEST_KEY = "adivinhia.bestScore";
// The AI only counts as having "guessed" the prompt when it is the #1 guess
// with high confidence AND holds that guess for several consecutive
// inferences. Requiring stability (not a single lucky frame) and real
// confidence keeps the round from ending the instant the sketch is barely
// readable — the player gets a moment of tension before the AI "locks in".
// The confidence level itself comes from the difficulty setting.
const REQUIRED_STREAK = 3; // consecutive confident hits (~3 * 250ms = 750ms)

/**
 * Single-player game loop:
 *  - Each round shows a prompt the player must draw.
 *  - The AI continuously guesses. If its top guess matches the prompt with
 *    enough confidence, the round is won.
 *  - Faster recognition => more points (scaled by remaining time).
 * Rounds, round length, AI confidence and hints come from Settings.
 */
export class Game {
  private totalRounds: number = DEFAULT_SETTINGS.rounds;
  private roundDuration: number = DEFAULT_SETTINGS.seconds;
  private confidenceThreshold = CONFIDENCE_BY_DIFFICULTY[DEFAULT_SETTINGS.difficulty];
  private hintsEnabled = DEFAULT_SETTINGS.hints;
  private bestKey = bestKeyFor(DEFAULT_SETTINGS);

  private phase: GamePhase = "idle";
  private round = 0;
  private score = 0;
  private prompt: Prompt | null = null;
  private timeLeft: number = DEFAULT_SETTINGS.seconds;
  private timerId: number | null = null;
  private deck: Prompt[] = [];
  private streak = 0; // consecutive confident correct guesses this round
  private bestScore = loadBestScore(this.bestKey, true);
  private isNewBest = false;
  private revealOrder: number[] = []; // randomized letter-reveal order for hints

  private onUpdate?: (s: GameSnapshot) => void;
  private onRoundEnd?: (r: RoundResult) => void;

  setOnUpdate(cb: (s: GameSnapshot) => void): void {
    this.onUpdate = cb;
  }
  setOnRoundEnd(cb: (r: RoundResult) => void): void {
    this.onRoundEnd = cb;
  }

  /** Apply player settings. Call before start(); takes effect on the next game. */
  configure(s: Settings): void {
    this.totalRounds = s.rounds;
    this.roundDuration = s.seconds;
    this.confidenceThreshold = CONFIDENCE_BY_DIFFICULTY[s.difficulty];
    this.hintsEnabled = s.hints;
    this.bestKey = bestKeyFor(s);
    this.bestScore = loadBestScore(this.bestKey, isDefaultSettings(s));
    this.isNewBest = false;
    if (this.phase === "idle") this.timeLeft = this.roundDuration;
  }

  /** Abandon the current game (e.g. back to the menu) without recording a score. */
  abort(): void {
    this.stopTimer();
    this.phase = "idle";
    this.round = 0;
    this.score = 0;
    this.prompt = null;
    this.streak = 0;
    this.isNewBest = false;
    this.timeLeft = this.roundDuration;
  }

  snapshot(): GameSnapshot {
    return {
      phase: this.phase,
      round: this.round,
      totalRounds: this.totalRounds,
      score: this.score,
      prompt: this.prompt,
      timeLeft: this.timeLeft,
      roundDuration: this.roundDuration,
      hint: this.buildHint(),
      bestScore: this.bestScore,
      isNewBest: this.isNewBest,
    };
  }

  /**
   * Build a progressively-revealed hint of the prompt's PT word. Letters are
   * uncovered as the round clock runs down: nothing at the start, and up to
   * ~60% of the letters by the time the timer is nearly out. Spaces and
   * hyphens are always shown; the reveal order is randomized per round so it
   * isn't always left-to-right. Returns "" when hints are turned off.
   */
  private buildHint(): string {
    if (!this.hintsEnabled || this.phase !== "playing" || !this.prompt) return "";
    const word = this.prompt.pt;
    const letterIdx: number[] = [];
    for (let i = 0; i < word.length; i++) {
      if (/[a-zà-ÿ]/i.test(word[i])) letterIdx.push(i);
    }
    const elapsed = 1 - this.timeLeft / this.roundDuration; // 0 → 1
    const maxReveal = Math.floor(letterIdx.length * 0.6);
    const revealCount = Math.min(maxReveal, Math.floor(elapsed * (maxReveal + 1)));

    const revealSet = new Set(this.revealOrder.slice(0, revealCount));
    let out = "";
    for (let i = 0; i < word.length; i++) {
      const ch = word[i];
      if (ch === " ") out += "  ";
      else if (ch === "-") out += "- ";
      else if (revealSet.has(i)) out += ch + " ";
      else out += "_ ";
    }
    return out.trim();
  }

  get currentPrompt(): Prompt | null {
    return this.prompt;
  }

  isPlaying(): boolean {
    return this.phase === "playing";
  }

  start(): void {
    this.score = 0;
    this.round = 0;
    this.isNewBest = false;
    this.deck = shuffle(PROMPTS).slice(0, this.totalRounds);
    this.nextRound();
  }

  private nextRound(): void {
    if (this.round >= this.totalRounds) {
      this.endGame();
      return;
    }
    this.prompt = this.deck[this.round];
    this.round += 1;
    this.timeLeft = this.roundDuration;
    this.streak = 0;
    this.phase = "playing";
    // Randomize which letters get revealed first for the hint.
    const idx: number[] = [];
    for (let i = 0; i < this.prompt.pt.length; i++) {
      if (/[a-zà-ÿ]/i.test(this.prompt.pt[i])) idx.push(i);
    }
    this.revealOrder = shuffle(idx);
    this.startTimer();
    this.emit();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timerId = window.setInterval(() => {
      this.timeLeft -= 1;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this.loseRound();
      }
      this.emit();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Feed the AI's current top guesses into the game. Returns true if this
   * guess won the round. Called by the inference loop while playing.
   *
   * A win requires the target to be the #1 guess with high confidence for
   * REQUIRED_STREAK consecutive inferences. Any frame that breaks the streak
   * (wrong top guess or low confidence) resets the counter, so the AI must
   * be genuinely and stably sure before the round ends.
   */
  submitGuesses(guesses: { label: string; probability: number }[]): boolean {
    if (this.phase !== "playing" || !this.prompt) return false;
    const top = guesses[0];
    const confident =
      top?.label === this.prompt.label &&
      top.probability >= this.confidenceThreshold;

    if (confident) {
      this.streak += 1;
      if (this.streak >= REQUIRED_STREAK) {
        this.winRound();
        return true;
      }
    } else {
      this.streak = 0;
    }
    return false;
  }

  private winRound(): void {
    this.stopTimer();
    this.phase = "roundWon";
    // Points scale with speed: full time left => more points.
    const points = 100 + Math.round((this.timeLeft / this.roundDuration) * 400);
    this.score += points;
    this.onRoundEnd?.({
      prompt: this.prompt!,
      won: true,
      pointsEarned: points,
      timeLeft: this.timeLeft,
    });
    this.emit();
  }

  private loseRound(): void {
    this.stopTimer();
    this.phase = "roundLost";
    this.onRoundEnd?.({
      prompt: this.prompt!,
      won: false,
      pointsEarned: 0,
      timeLeft: 0,
    });
    this.emit();
  }

  /** Advance to the next round (called by UI after showing round result). */
  advance(): void {
    if (this.phase === "roundWon" || this.phase === "roundLost") {
      this.nextRound();
    }
  }

  /** Player gives up on the current round. */
  skip(): void {
    if (this.phase === "playing") {
      this.loseRound();
    }
  }

  private endGame(): void {
    this.stopTimer();
    this.phase = "gameOver";
    this.prompt = null;
    if (this.score > this.bestScore) {
      this.bestScore = this.score;
      this.isNewBest = true;
      saveBestScore(this.bestKey, this.bestScore);
    }
    this.emit();
  }

  private emit(): void {
    this.onUpdate?.(this.snapshot());
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Best scores are only comparable within the same rounds/time/difficulty. */
function bestKeyFor(s: Settings): string {
  return `adivinhia.best.${s.rounds}.${s.seconds}.${s.difficulty}`;
}

function loadBestScore(key: string, useLegacy: boolean): number {
  try {
    const raw =
      localStorage.getItem(key) ??
      (useLegacy ? localStorage.getItem(LEGACY_BEST_KEY) : null);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0; // localStorage may be unavailable (private mode, etc.)
  }
}

function saveBestScore(key: string, score: number): void {
  try {
    localStorage.setItem(key, String(score));
  } catch {
    /* ignore persistence failures */
  }
}
