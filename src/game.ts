import { PROMPTS, type Prompt } from "./prompts";

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
  /** Best score ever (persisted in localStorage). */
  bestScore: number;
  /** True at game over if this run beat the stored best score. */
  isNewBest: boolean;
}

const ROUND_DURATION = 20; // seconds per round
const TOTAL_ROUNDS = 6;
const BEST_SCORE_KEY = "adivinhia.bestScore";
// The AI only counts as having "guessed" the prompt when it is the #1 guess
// with high confidence AND holds that guess for several consecutive
// inferences. Requiring stability (not a single lucky frame) and real
// confidence keeps the round from ending the instant the sketch is barely
// readable — the player gets a moment of tension before the AI "locks in".
const CONFIDENCE_THRESHOLD = 0.65;
const REQUIRED_STREAK = 3; // consecutive confident hits (~3 * 250ms = 750ms)

/**
 * Single-player game loop:
 *  - Each round shows a prompt the player must draw.
 *  - The AI continuously guesses. If its top guess matches the prompt with
 *    enough confidence, the round is won.
 *  - Faster recognition => more points (scaled by remaining time).
 */
export class Game {
  private phase: GamePhase = "idle";
  private round = 0;
  private score = 0;
  private prompt: Prompt | null = null;
  private timeLeft = ROUND_DURATION;
  private timerId: number | null = null;
  private deck: Prompt[] = [];
  private streak = 0; // consecutive confident correct guesses this round
  private bestScore = loadBestScore();
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

  snapshot(): GameSnapshot {
    return {
      phase: this.phase,
      round: this.round,
      totalRounds: TOTAL_ROUNDS,
      score: this.score,
      prompt: this.prompt,
      timeLeft: this.timeLeft,
      roundDuration: ROUND_DURATION,
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
   * isn't always left-to-right.
   */
  private buildHint(): string {
    if (this.phase !== "playing" || !this.prompt) return "";
    const word = this.prompt.pt;
    const letterIdx: number[] = [];
    for (let i = 0; i < word.length; i++) {
      if (/[a-zà-ÿ]/i.test(word[i])) letterIdx.push(i);
    }
    const elapsed = 1 - this.timeLeft / ROUND_DURATION; // 0 → 1
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
    this.deck = shuffle(PROMPTS).slice(0, TOTAL_ROUNDS);
    this.nextRound();
  }

  private nextRound(): void {
    if (this.round >= TOTAL_ROUNDS) {
      this.endGame();
      return;
    }
    this.prompt = this.deck[this.round];
    this.round += 1;
    this.timeLeft = ROUND_DURATION;
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
      top.probability >= CONFIDENCE_THRESHOLD;

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
    const points = 100 + Math.round((this.timeLeft / ROUND_DURATION) * 400);
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
      saveBestScore(this.bestScore);
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

function loadBestScore(): number {
  try {
    const raw = localStorage.getItem(BEST_SCORE_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0; // localStorage may be unavailable (private mode, etc.)
  }
}

function saveBestScore(score: number): void {
  try {
    localStorage.setItem(BEST_SCORE_KEY, String(score));
  } catch {
    /* ignore persistence failures */
  }
}
