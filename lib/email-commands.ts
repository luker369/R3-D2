/**
 * Detects the two email commands and nothing else.
 *
 * Preferred (structured) draft form — gives subject and body their own slots so
 * a Whisper mishearing in one can't bleed into the other:
 *
 *   "draft an email to luke at gmail dot com. Subject: R2 demo. Body: Quick
 *    note about Friday."
 *     → { kind: 'draft', to: '<normalized>', subject: 'R2 demo', message: '...' }
 *
 * Legacy/natural form — still supported; subject is derived from the first
 * clause of the body:
 *
 *   "draft an email to luke@example.com saying hey want to meet friday"
 *     → { kind: 'draft', to: '<normalized>', message: '...' }  (no subject)
 *
 * Reply form:
 *
 *   "reply to that email and say sure, 3pm works"
 *   "reply and say thanks"
 *     → { kind: 'reply', message: '...' }
 *
 * Anything else returns null — caller falls through to the normal LLM pipeline.
 * No contacts lookup.
 */

export type EmailCommand =
  | { kind: 'draft'; to: string; subject?: string; message: string }
  | { kind: 'reply'; message: string };

// Draft head: verb + optional "an email" + required "to ". Everything after
// this is recipient + (optional structured fields) OR "saying ..." fallback.
const DRAFT_HEAD_RE =
  /^(?:draft|send|compose|write|email)\s+(?:an?\s+)?(?:email\s+)?to\s+/i;

// Legacy fallback — "... to X saying/that-says/and-say Y"
const DRAFT_LEGACY_RE =
  /^(?:draft|send|compose|write|email)\s+(?:an?\s+)?(?:email\s+)?to\s+(.+?)\s+(?:saying|that\s+says|and\s+say)\s+(.+)/i;

// Markers used by the structured form. "subject" / "subject line",
// "body" / "message" / "content". Colon/comma/dash between marker and value
// are optional because Whisper drops them unpredictably.
const SUBJECT_MARKER_RE = /\bsubject(?:\s+line)?\b\s*[:,\-]?\s*/i;
const BODY_MARKER_RE    = /\b(?:body|message|content)\b\s*[:,\-]?\s*/i;

// "reply to that (email) and say Y" / "reply and say Y" / "reply with Y"
const REPLY_RE =
  /^reply(?:\s+to\s+(?:that|it|the\s+email|the\s+last\s+(?:one|email)))?\s+(?:(?:and\s+say)|(?:saying)|with)\s+(.+)/i;

/**
 * Turns "luke at gmail dot com" into "luke@gmail.com". Also strips trailing
 * punctuation Whisper adds. If the result still isn't a valid-looking email,
 * returns null so the caller can respond with "I need a full email address".
 */
export function normalizeSpokenAddress(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase().replace(/[.,!?;:]+$/, '');

  // If it already has an @, trust it (just strip spaces around it).
  if (s.includes('@')) {
    s = s.replace(/\s*@\s*/g, '@').replace(/\s+/g, '');
  } else {
    // Spoken form: "name at domain dot com" / "name at gmail dot com"
    s = s
      .replace(/\s+at\s+/g, '@')
      .replace(/\s+dot\s+/g, '.')
      .replace(/\s+/g, '');
  }

  // Pragmatic check — one @, something before, at least one dot after.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

/**
 * Build a short subject from the body. Only used by the legacy form —
 * structured form dictates subject directly and skips this entirely.
 * Takes the first sentence-ish clause, capped at 8 words / 60 chars.
 */
export function deriveSubject(body: string): string {
  const cleaned = body.trim().replace(/\s+/g, ' ');
  if (!cleaned) return 'Note';
  const firstClause = cleaned.split(/[.!?]/)[0] || cleaned;
  const words = firstClause.split(' ').slice(0, 8).join(' ');
  const capped = words.length > 60 ? words.slice(0, 57).trimEnd() + '…' : words;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

function trimBoundaryPunct(s: string): string {
  return s.trim().replace(/^[.,;:\s]+/, '').replace(/[.,;:\s]+$/, '');
}

/**
 * Structured parse: "draft an email to X. Subject: Y. Body: Z."
 * Both markers must appear in order (subject before body). Returns null if
 * either marker is missing so the caller can fall back to the legacy form.
 * Parsed step-by-step instead of one mega-regex because the step version is
 * easier to debug when Whisper produces odd spacing or punctuation.
 */
function parseStructuredDraft(
  s: string,
): { to: string; subject: string; body: string } | null {
  const head = s.match(DRAFT_HEAD_RE);
  if (!head) return null;
  const rest = s.slice(head[0].length);

  const subjMatch = rest.match(SUBJECT_MARKER_RE);
  if (!subjMatch || subjMatch.index === undefined) return null;

  const to = trimBoundaryPunct(rest.slice(0, subjMatch.index));
  const afterSubject = rest.slice(subjMatch.index + subjMatch[0].length);

  const bodyMatch = afterSubject.match(BODY_MARKER_RE);
  if (!bodyMatch || bodyMatch.index === undefined) return null;

  const subject = trimBoundaryPunct(afterSubject.slice(0, bodyMatch.index));
  const body = trimBoundaryPunct(
    afterSubject.slice(bodyMatch.index + bodyMatch[0].length),
  );

  if (!to || !subject || !body) return null;
  return { to, subject, body };
}

export function detectEmailCommand(text: string): EmailCommand | null {
  // Only strip trailing terminal punct; inner punct is load-bearing for the
  // structured form (the period between "to X" and "Subject:" is a cue).
  const s = text.trim().replace(/[!?]+$/, '').replace(/\.+$/, '').trim();
  if (!s) return null;

  const reply = s.match(REPLY_RE);
  if (reply?.[1]) return { kind: 'reply', message: reply[1].trim() };

  // Prefer the structured form when both markers are present.
  const structured = parseStructuredDraft(s);
  if (structured) {
    return {
      kind: 'draft',
      to: structured.to,
      subject: structured.subject,
      message: structured.body,
    };
  }

  // Legacy fallback: "... saying Y". Subject will be derived by the caller.
  const legacy = s.match(DRAFT_LEGACY_RE);
  if (legacy?.[1] && legacy?.[2]) {
    return { kind: 'draft', to: legacy[1].trim(), message: legacy[2].trim() };
  }

  return null;
}
