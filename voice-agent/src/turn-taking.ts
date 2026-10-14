// Pure decision functions for when the assistant starts and stops speaking.

import type { StartSpeakingPlan, StopSpeakingPlan } from "./config.js";

/** How long to wait for more speech before treating the user's turn as over. */
export function endpointDelaySeconds(text: string, plan: StartSpeakingPlan): number {
  const trimmed = text.trim();
  if (/\d$/.test(trimmed)) return plan.onNumberSeconds;
  if (/[.!?]$/.test(trimmed)) return plan.onPunctuationSeconds;
  return plan.onNoPunctuationSeconds;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
}

export function wordCount(text: string): number {
  const normalized = normalize(text);
  return normalized ? normalized.split(" ").length : 0;
}

export function isAcknowledgement(text: string, plan: StopSpeakingPlan): boolean {
  const normalized = normalize(text);
  return plan.acknowledgementPhrases.some((p) => normalize(p) === normalized);
}

/**
 * Decide whether speech heard while the assistant is talking should cut it off.
 * `text` is everything transcribed since the user started talking over it.
 */
export function shouldInterrupt(text: string, plan: StopSpeakingPlan): boolean {
  const normalized = normalize(text);
  if (!normalized) return plan.numWords === 0;
  if (plan.interruptionPhrases.some((p) => ` ${normalized} `.includes(` ${normalize(p)} `))) {
    return true;
  }
  if (isAcknowledgement(normalized, plan)) return false;
  return wordCount(normalized) >= plan.numWords;
}
