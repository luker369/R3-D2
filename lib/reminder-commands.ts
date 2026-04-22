/**
 * Dead-simple regex detector for the two reminder commands. Not a router —
 * if nothing matches, return null and the caller falls through to the normal
 * GPT flow unchanged.
 *
 *   "remind me at 3pm to call mom"        → { kind:'create', timeSpec:'at 3pm',         title:'call mom' }
 *   "remind me in 30 minutes to stretch"  → { kind:'create', timeSpec:'in 30 minutes',  title:'stretch'   }
 *   "remind me tomorrow at 9am to file"   → { kind:'create', timeSpec:'tomorrow at 9am', title:'file'      }
 *   "what reminders do I have today?"     → { kind:'list' }
 *   "my reminders"                        → { kind:'list' }
 *
 * Narrow by design. Does NOT handle "remind me to X at Y" (time after title).
 * Falls through to the LLM for unrecognized shapes.
 */

export type ReminderCommand =
  | { kind: 'create'; timeSpec: string; title: string }
  | { kind: 'list' };

// "remind me <time> to <title>" where <time> starts with at / in / tomorrow / today.
// The time branch is intentionally constrained so "remind me to X" (no time) does
// not spuriously match with a garbage time spec.
const CREATE_RE =
  /^remind\s+me\s+(at\s+.+?|in\s+\d.+?|tomorrow(?:\s+at)?\s+.+?|today(?:\s+at)?\s+.+?)\s+to\s+(.+)/i;

// "what reminders do I have today", "what are my reminders", "list my reminders",
// "show me reminders", "my reminders", "reminders"
const LIST_RE =
  /^(?:what\s+reminders?(?:\s+do\s+i\s+have)?(?:\s+today)?|what\s+are\s+my\s+reminders?|list\s+(?:my\s+)?reminders?|show\s+(?:me\s+)?(?:my\s+)?reminders?|my\s+reminders?|reminders?)$/i;

export function detectReminderCommand(text: string): ReminderCommand | null {
  const s = text.trim().replace(/[.!?]+$/, '').trim();
  if (!s) return null;

  const m = s.match(CREATE_RE);
  if (m?.[1] && m[2]) {
    return { kind: 'create', timeSpec: m[1].trim(), title: m[2].trim() };
  }

  if (LIST_RE.test(s)) return { kind: 'list' };

  return null;
}
