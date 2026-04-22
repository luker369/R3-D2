/**
 * Detects the daily-briefing command. Narrow by design — must NOT overlap with
 * the calendar-read path ("what's today look like" stays with calendar). The
 * assistant's job here is the full synthesis across calendar, email, tasks,
 * reminders, and memory; a bare calendar-only question shouldn't trigger it.
 */

const PATTERNS: RegExp[] = [
  /^what(?:'?s)?\s+should\s+i\s+(?:do|focus\s+on|work\s+on)\s+today$/i,
  /^what(?:'?s)?\s+(?:matters|important|my\s+focus)\s+today$/i,
  /^what\s+do\s+i\s+need\s+to\s+(?:do|focus\s+on)\s+today$/i,
  /^(?:brief\s+me|daily\s+brief(?:ing)?|give\s+me\s+(?:my\s+)?(?:daily\s+)?brief(?:ing)?|plan\s+my\s+day)$/i,
];

export function detectSynthesisCommand(text: string): boolean {
  const s = text.trim().replace(/[.!?]+$/, '').trim();
  if (!s) return false;
  return PATTERNS.some(re => re.test(s));
}
