/**
 * Minimal speech → Date parser for reminder time specs. Pure function, no
 * LLM round-trip, no date library. Handles the common forms; returns null
 * for everything else so the caller can ask the user to rephrase.
 *
 * Supported specs (case-insensitive, leading "at "/"on " stripped):
 *   "3pm"             → today at 15:00 (or tomorrow if past)
 *   "3 pm"            → same
 *   "3:30pm" / "15:30"
 *   "5"               → interpreted as 5 AM (no meridiem given)
 *   "tomorrow at 5pm" → tomorrow 17:00
 *   "today at 9am"    → today 09:00
 *   "in 30 minutes" / "in 2 hours"
 *   "noon" / "midnight"
 *
 * Intentional non-goals: day-of-week, "next Monday", "on May 3rd",
 * absolute dates. Add LLM parsing if real usage demands those.
 */

export function parseReminderTime(spec: string, now: Date = new Date()): Date | null {
  const s = spec.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  if (!s) return null;

  // "in N minutes|hours"
  const rel = s.match(/^in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const isHour = /^hour|^hr/.test(rel[2]);
    const ms = isHour ? n * 60 * 60 * 1000 : n * 60 * 1000;
    return new Date(now.getTime() + ms);
  }

  // Strip "tomorrow"/"today" prefix (optionally with "at")
  let forceTomorrow = false;
  let rest = s;
  if (/^tomorrow(\s+at)?\s+/.test(rest)) {
    forceTomorrow = true;
    rest = rest.replace(/^tomorrow(\s+at)?\s+/, '');
  } else if (/^today(\s+at)?\s+/.test(rest)) {
    rest = rest.replace(/^today(\s+at)?\s+/, '');
  }
  rest = rest.replace(/^at\s+/, '');

  if (rest === 'noon') return atHour(now, 12, 0, forceTomorrow);
  if (rest === 'midnight') return atHour(now, 0, 0, forceTomorrow);

  // "5", "5pm", "5 pm", "5:30", "5:30pm", "17:00"
  const t = rest.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!t) return null;
  let hour = parseInt(t[1], 10);
  const minute = t[2] ? parseInt(t[2], 10) : 0;
  const meridiem = t[3];
  if (hour > 23 || minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  return atHour(now, hour, minute, forceTomorrow);
}

function atHour(now: Date, hour: number, minute: number, forceTomorrow: boolean): Date {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  // If time already passed today and user didn't say "tomorrow", roll to
  // tomorrow. If they did say "tomorrow" we force it regardless of current hour.
  if (forceTomorrow || d.getTime() <= now.getTime()) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * Short human-readable time label for confirmation speech. Today gets just
 * the clock time, tomorrow gets "tomorrow at …", anything further out gets a
 * short date.
 */
export function formatReminderTime(date: Date, now: Date = new Date()): string {
  const hour24 = date.getHours();
  const minute = date.getMinutes();
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour24 + 11) % 12) + 1;
  const mm = String(minute).padStart(2, '0');
  const time = minute === 0 ? `${hour12} ${meridiem}` : `${hour12}:${mm} ${meridiem}`;

  if (date.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}
