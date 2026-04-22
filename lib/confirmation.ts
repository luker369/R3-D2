/**
 * Narrow yes/no detector for two-turn confirmation flows. Deliberately strict —
 * partial or qualified responses ("yes but make it 2pm") return null so the
 * caller can drop the pending state and let normal processing handle the new
 * utterance. Never returns 'yes' when the user's intent is ambiguous.
 */

export type Confirmation = 'yes' | 'no' | null;

const YES_RE =
  /^(?:yes|yeah|yep|yup|sure|okay|ok|confirm(?:ed)?|please|please\s+do|do\s+it|create\s+it|schedule\s+it|book\s+it|add\s+it|go\s+ahead|sounds\s+good|correct)$/i;

const NO_RE =
  /^(?:no|nope|nah|cancel|stop|don'?t|do\s+not|skip|forget\s+it|never\s*mind|negative|wait|hold\s+on)$/i;

export function detectConfirmation(text: string): Confirmation {
  const s = text.trim().replace(/[.!?]+$/, '').trim();
  if (!s) return null;
  if (YES_RE.test(s)) return 'yes';
  if (NO_RE.test(s)) return 'no';
  return null;
}
