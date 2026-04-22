/**
 * Whisper hallucination filters, extracted from hooks/use-voice-assistant.ts
 * as pure functions so they can be unit-tested without pulling in the hook.
 * Behavior is unchanged from the original inline implementation.
 */

export const HALLUCINATIONS = new Set([
  "thanks for watching",
  "thank you for watching",
  "thanks a lot for watching",
  "thank you so much for watching",
  "please subscribe",
  "like and subscribe",
  "subscribe",
  "thank you",
  "thanks",
  "you",
  "the",
  "okay",
  "ok",
  "yeah",
  "yes",
  "no",
  "hmm",
  "um",
  "uh",
  "bye",
  "goodbye",
  "see you",
  "see you later",
  "have a good day",
  "have a great day",
  "take care",
]);

export const HALLUCINATION_SUBSTRINGS = [
  "if you have any questions or comments, please post them in the comments",
  "if you have any questions or other problems, please post them in the comments",
  "casual message to an ai voice assistant",
  "casual spoken message to an ai voice assistant",
  "this is a test",
  "testing testing",
  "brought to you by",
  "don't forget to subscribe",
  "smash the like button",
  "in this video",
  "in today's video",
  "welcome back to",
  "for watching this video",
  "r3-d2, a personal voice assistant",
  "this video was made possible",
  "help and contributions from the youtube community",
  "what is you favorite english word",
  "what is your favorite english word",
  "let us know in the comments",
  "derivative work of the touhou project",
  "resemblance to anyone, living or dead, is coincidental",
  "conversational english",
];

/**
 * Drop only the sentences that contain a known hallucination substring,
 * preserving any real question Whisper prepended/appended cruft to.
 * Returns the cleaned text; caller decides whether the remainder is usable.
 */
export function stripHallucinationSentences(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  for (const s of sentences) {
    const norm = s.toLowerCase().trim();
    if (HALLUCINATION_SUBSTRINGS.some((h) => norm.includes(h))) continue;
    kept.push(s);
  }
  return kept.join(" ").trim();
}

export function isHallucination(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .trim()
    .replace(/[.!?,]+$/, "");
  if (HALLUCINATIONS.has(normalized)) return true;
  if (HALLUCINATION_SUBSTRINGS.some((s) => normalized.includes(s))) return true;

  // Reject if >40% of words are repeated — Whisper looping artifact
  const words = normalized.split(/\s+/);
  if (words.length >= 6) {
    const unique = new Set(words).size;
    if (unique / words.length < 0.5) return true;
  }

  return false;
}
