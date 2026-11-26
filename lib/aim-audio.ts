// =============================================================================
// aim-audio — the pure half of the aiming aid
// =============================================================================
// Pointing a dish is done with both hands and both eyes on the mount, so the
// screen is not where the operator is looking. This module turns two consecutive
// readings into the three things the audible aid needs — a direction, a pitch and
// a rate — and nothing else. No `AudioContext`, no `speechSynthesis`, no DOM, so
// it can be reasoned about (and replayed from a recorded series) on the build
// machine rather than only in a field.
//
// THE SCALE IS HYSTERESIS-FIRST, on purpose. The modulus here is a metric with
// 0.5 dB of jitter between samples at a fixed pointing, so a beep on every change
// is a beep on noise. A step has to clear `TREND_STEP_DB` before it counts as a
// move, and the previous *confirmed* direction is what the steady case reports —
// so a series of +1, −1, +1 reads as steady rather than as an alarm.
//
// PITCH CARRIES SIGN, NOT MAGNITUDE. Higher is better: rising to a higher note is
// the cue an operator already knows from a metal detector or a stud finder, and a
// note is far easier to place than a loudness difference on a phone speaker held
// at arm's length. Magnitude is carried by REPETITION (a wider improvement beeps
// more often), never by volume — volume is the phone's own setting and the
// operator has already chosen it.
// =============================================================================

/** How far a reading must move, in dB, before it counts as a move. */
export const TREND_STEP_DB = 2;

/** The direction of travel between two readings. */
export type AimTrend = "improving" | "degrading" | "steady" | "unknown";

/**
 * Compare two readings on a metric where higher is better (RSRP, SINR).
 *
 * `unknown` is a real answer and it is not `steady`: with one reading there is no
 * direction to report, and a beep that says "steady" before anything has been
 * compared would teach the operator to trust a cue that is not yet measuring.
 */
export function aimTrend(
  previous: number | null,
  next: number | null,
  stepDb: number = TREND_STEP_DB,
): AimTrend {
  if (previous === null || next === null) return "unknown";
  const delta = next - previous;
  if (delta >= stepDb) return "improving";
  if (delta <= -stepDb) return "degrading";
  return "steady";
}

/** The house tones, in Hz. Rising for better, falling for worse, a middle click for flat. */
const TONE_HZ = {
  improving: 1046.5,
  degrading: 392,
  steady: 659.25,
} as const;

/**
 * The note for a trend, in Hz (A6 / G4 / E5).
 *
 * Always positive: `unknown` has no note at all, and the caller must not ask for
 * one — see `shouldBeep`.
 */
export function toneHz(trend: AimTrend): number | null {
  if (trend === "unknown") return null;
  return TONE_HZ[trend];
}

/**
 * Whether this transition is worth a sound at all.
 *
 * Only a MOVE is. A steady sample is silent: at 1 Hz a flat reading would
 * otherwise click once a second for as long as the reader holds still, which is
 * both annoying and — worse — indistinguishable from the click that means
 * "nothing is happening here, keep turning".
 */
export function shouldBeep(trend: AimTrend): boolean {
  return trend === "improving" || trend === "degrading";
}

/**
 * How long the note lasts, in milliseconds.
 *
 * Longer for a drop: an operator who is being told "worse" needs the cue to
 * survive the half-second they spend deciding whether they moved the dish or the
 * tower did something. An improvement is a short, bright chirp — the thing they
 * want to hear again.
 */
export function toneMs(trend: AimTrend): number {
  return trend === "degrading" ? 220 : 130;
}

/** The shortest gap between two beeps, so a fast series cannot become a buzz. */
export const MIN_BEEP_GAP_MS = 450;

/** The shortest gap between two spoken readings. Speech is slower to parse than a note. */
export const MIN_SPEAK_GAP_MS = 6_000;
