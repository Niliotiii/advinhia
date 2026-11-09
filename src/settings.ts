/**
 * Player-configurable settings, persisted in localStorage.
 *
 * Only options that actually change gameplay are exposed:
 *  - rounds / seconds per round
 *  - AI difficulty: how confident the AI must be before it "locks in" a guess
 *  - progressive hints on/off
 *  - brush size
 * The player name lives in its own key because the multiplayer lobby
 * (room.ts) already reads it from there.
 */

export type Difficulty = "easy" | "normal" | "hard";
export type Brush = "thin" | "medium" | "thick";

export interface Settings {
  rounds: 3 | 6 | 10;
  seconds: 15 | 20 | 30;
  difficulty: Difficulty;
  hints: boolean;
  brush: Brush;
}

export const DEFAULT_SETTINGS: Settings = {
  rounds: 6,
  seconds: 20,
  difficulty: "normal",
  hints: true,
  brush: "medium",
};

/** Minimum AI confidence for a correct guess, per difficulty. */
export const CONFIDENCE_BY_DIFFICULTY: Record<Difficulty, number> = {
  easy: 0.5,
  normal: 0.65,
  hard: 0.8,
};

/** Brush width in canvas pixels (canvas is 420x420). */
export const BRUSH_PX: Record<Brush, number> = {
  thin: 10,
  medium: 14,
  thick: 20,
};

const SETTINGS_KEY = "adivinhia.settings";
const NAME_KEY = "adivinhia.name";

const ROUNDS: Settings["rounds"][] = [3, 6, 10];
const SECONDS: Settings["seconds"][] = [15, 20, 30];
const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"];
const BRUSHES: Brush[] = ["thin", "medium", "thick"];

/** Validate untrusted stored data field by field, falling back to defaults. */
function sanitize(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <T>(list: T[], v: unknown, fallback: T): T =>
    list.includes(v as T) ? (v as T) : fallback;
  return {
    rounds: pick(ROUNDS, r.rounds, DEFAULT_SETTINGS.rounds),
    seconds: pick(SECONDS, r.seconds, DEFAULT_SETTINGS.seconds),
    difficulty: pick(DIFFICULTIES, r.difficulty, DEFAULT_SETTINGS.difficulty),
    hints: typeof r.hints === "boolean" ? r.hints : DEFAULT_SETTINGS.hints,
    brush: pick(BRUSHES, r.brush, DEFAULT_SETTINGS.brush),
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return sanitize(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private mode) — settings just won't persist */
  }
}

export function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name.trim().slice(0, 24));
  } catch {
    /* ignore */
  }
}

export function isDefaultSettings(s: Settings): boolean {
  return (
    s.rounds === DEFAULT_SETTINGS.rounds &&
    s.seconds === DEFAULT_SETTINGS.seconds &&
    s.difficulty === DEFAULT_SETTINGS.difficulty
  );
}
