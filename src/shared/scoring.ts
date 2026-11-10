/**
 * Cross-verified scoring.
 *
 * Every player's browser runs the AI on EVERY drawing of the game and reports
 * what it saw. The final score of a drawing is the median of those reports,
 * so a single tampered client cannot inflate its own score or sink someone
 * else's as long as there are 3+ evaluators. With only 2 evaluators there is
 * no tie-breaker: the median is their average, and a large disagreement is
 * flagged so the players can see it.
 */

/** Spread (max - min), as a probability, above which evaluators are said to disagree. */
export const DISPUTE_SPREAD = 0.1;

/** Median; for an even count, the mean of the two middle values. */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface DrawingScore {
  /** integer percentage 0..100 */
  percent: number;
  /** evaluators disagreed by more than DISPUTE_SPREAD */
  disputed: boolean;
}

/** Combine the probabilities (0..1) different evaluators gave to ONE drawing. */
export function aggregateDrawing(values: number[]): DrawingScore {
  if (values.length === 0) return { percent: 0, disputed: false };
  const spread = Math.max(...values) - Math.min(...values);
  return {
    percent: Math.round(median(values) * 100),
    disputed: values.length > 1 && spread > DISPUTE_SPREAD,
  };
}
