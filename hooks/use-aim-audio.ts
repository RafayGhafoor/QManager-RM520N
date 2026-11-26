"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  MIN_BEEP_GAP_MS,
  MIN_SPEAK_GAP_MS,
  shouldBeep,
  toneHz,
  toneMs,
  type AimTrend,
} from "@/lib/aim-audio";

// =============================================================================
// useAimAudio — the audible aiming aid
// =============================================================================
// Two independent voices, both optional and both OFF until asked for:
//
//   beeps — a short Web Audio note per confirmed move; higher for better, lower
//           for worse. This is the primary channel: a note is understood
//           peripherally, in the half-second between two turns of a dish.
//   voice — the reading spoken aloud through `speechSynthesis`, throttled hard.
//           It is the backup for a phone in a pocket, and for anyone who cannot
//           place a pitch.
//
// WHY BOTH ARE OPT-IN AND PERSISTED. This page is also opened on a desk, in an
// office, or next to somebody else at 2 a.m.; a surface that starts beeping on
// mount is a surface people close. The preference is remembered per browser so a
// second visit does not ask again.
//
// WHY THE CONTEXT IS CREATED IN A CLICK. Every browser refuses to start an
// `AudioContext` outside a user gesture, and a resumed-then-suspended context is
// the usual cause of "the toggle is on but nothing beeps". The toggles are
// therefore the only things that create it, and the tick handler only ever
// *plays* on a context that already exists and is running.
//
// COST: zero while off. An armed context costs nothing until a note is played,
// and each note is an `OscillatorNode` + `GainNode` with a real envelope that is
// stopped and disconnected on release — no idle oscillator, no polling timer. The
// hook itself holds refs only; it makes no request of any kind.
// =============================================================================

/** Nothing to subscribe to: a capability is not a changing value. */
const NO_SUBSCRIPTION = () => () => {};

const BEEPS_KEY = "qm_aim_beeps";
const VOICE_KEY = "qm_aim_voice";

function readPref(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    // Private mode, or storage disabled. Off is the safe answer.
    return false;
  }
}

function writePref(key: string, on: boolean) {
  try {
    window.localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Ignored on purpose: the toggle still works for this session.
  }
}

export interface UseAimAudioReturn {
  /** Play a note for this transition, if beeps are on and it is worth a sound. */
  beep: (trend: AimTrend) => void;
  /** Speak a line, if voice is on and the last line was long enough ago. */
  speak: (text: string) => void;
  beepsOn: boolean;
  voiceOn: boolean;
  /** Arms (or disarms) the note channel. Must be called from a click. */
  toggleBeeps: () => void;
  /** Arms (or disarms) the speech channel. Must be called from a click. */
  toggleVoice: () => void;
  /** False where the browser has no speech synthesis — the control is hidden. */
  voiceSupported: boolean;
}

export function useAimAudio(): UseAimAudioReturn {
  const [beepsOn, setBeepsOn] = useState(() => readPref(BEEPS_KEY));
  const [voiceOn, setVoiceOn] = useState(() => readPref(VOICE_KEY));
  // Feature-detected through `useSyncExternalStore` rather than an effect that
  // sets state: `speechSynthesis` is a browser global, so the server and the
  // first client render must agree on an answer (`false`), and only the second
  // read may consult the window. The subscription is a no-op — the capability
  // never changes — which is exactly what the third argument is for.
  const voiceSupported = useSyncExternalStore(
    NO_SUBSCRIPTION,
    () => typeof window !== "undefined" && "speechSynthesis" in window,
    () => false,
  );

  const ctxRef = useRef<AudioContext | null>(null);
  const lastBeepAtRef = useRef(0);
  const lastSpeakAtRef = useRef(0);

  /** Create or resume the context. Only ever called from a click. */
  const arm = useCallback(() => {
    if (typeof window === "undefined") return null;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    if (ctxRef.current === null) {
      try {
        ctxRef.current = new Ctor();
      } catch {
        return null;
      }
    }
    if (ctxRef.current.state === "suspended") void ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  const toggleBeeps = useCallback(() => {
    setBeepsOn((on) => {
      const next = !on;
      writePref(BEEPS_KEY, next);
      if (next) {
        // Creating it inside the handler IS the gesture the browser wants.
        arm();
        // A short confirmation note, so "on" is audible without waiting for the
        // first move — otherwise the control looks broken until the dish moves.
        const ctx = ctxRef.current;
        if (ctx !== null) playTone(ctx, 659.25, 110);
      }
      return next;
    });
  }, [arm]);

  const toggleVoice = useCallback(() => {
    setVoiceOn((on) => {
      const next = !on;
      writePref(VOICE_KEY, next);
      if (next && typeof window !== "undefined" && "speechSynthesis" in window) {
        // Cancels any line still queued from a previous session.
        window.speechSynthesis.cancel();
      }
      return next;
    });
  }, []);

  const beep = useCallback((trend: AimTrend) => {
    if (!shouldBeep(trend)) return;
    const ctx = ctxRef.current;
    if (ctx === null || ctx.state !== "running") return;
    const now = Date.now();
    if (now - lastBeepAtRef.current < MIN_BEEP_GAP_MS) return;
    const hz = toneHz(trend);
    if (hz === null) return;
    lastBeepAtRef.current = now;
    playTone(ctx, hz, toneMs(trend));
  }, []);

  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const now = Date.now();
    if (now - lastSpeakAtRef.current < MIN_SPEAK_GAP_MS) return;
    lastSpeakAtRef.current = now;
    const line = new SpeechSynthesisUtterance(text);
    // Slightly under conversational pace: this is a number to act on, heard from
    // an arm's length away, often over wind.
    line.rate = 0.95;
    line.pitch = 1;
    // Never queue: an operator needs the CURRENT reading, not a backlog.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(line);
  }, []);

  // Leaving the surface silences anything still speaking, so a route change
  // cannot leave a voice talking in an empty tab.
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  return {
    beep,
    speak,
    beepsOn,
    voiceOn,
    toggleBeeps,
    toggleVoice,
    voiceSupported,
  };
}

/**
 * One note: a sine with a fast attack and an exponential release.
 *
 * The envelope is not decoration. A bare `start`/`stop` on an oscillator is a
 * click at both ends on a phone speaker, and a click is exactly the noise the
 * beeps have to be told apart from. Nodes are stopped and disconnected on the
 * release, so nothing is left running between samples.
 */
function playTone(ctx: AudioContext, hz: number, ms: number) {
  const now = ctx.currentTime;
  const seconds = ms / 1000;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(hz, now);

  // Peak is 0.18, not 1: this plays out of a handset beside someone's ear.
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + seconds + 0.02);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}
