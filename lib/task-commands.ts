/**
 * Dead-simple regex detector for the three task commands. Not a router —
 * if nothing matches, return null and the caller falls through to the normal
 * GPT flow unchanged.
 *
 *   "add a task: buy milk"       → { kind: 'add',  title: 'buy milk' }
 *   "what are my tasks?"         → { kind: 'list' }
 *   "mark task done: buy milk"   → { kind: 'done', titleFragment: 'buy milk' }
 *
 * Narrow by design. If the user phrases something sideways, it falls through
 * to the LLM — which is fine. Expand regexes here if real usage patterns
 * show common misses.
 */

export type TaskCommand =
  | { kind: 'add';  title: string }
  | { kind: 'list' }
  | { kind: 'done'; titleFragment: string };

// "add a task: X", "add task: X", "create a task: X", "new task: X"
const ADD_RE = /^(?:add|create|new)\s+(?:a\s+)?task\s*[:\-]?\s+(.+)/i;

// "what are my tasks?", "list my tasks", "show me my tasks", "my tasks", "tasks"
const LIST_RE = /^(?:(?:what\s+(?:are|is)\s+my\s+tasks?)|(?:list\s+(?:my\s+)?tasks?)|(?:show\s+(?:me\s+)?(?:my\s+)?tasks?)|(?:my\s+tasks?)|tasks?)$/i;

// "mark task done: X", "mark task complete: X", "complete task: X", "finish task: X"
const DONE_RE = /^(?:(?:mark\s+task\s+(?:done|complete|finished))|(?:complete\s+task)|(?:finish\s+task))\s*[:\-]?\s+(.+)/i;

export function detectTaskCommand(text: string): TaskCommand | null {
  // Strip trailing punctuation Whisper tends to add. Keep inner punctuation.
  const s = text.trim().replace(/[.!?]+$/, '').trim();
  if (!s) return null;

  const add = s.match(ADD_RE);
  if (add?.[1]) return { kind: 'add', title: add[1].trim() };

  if (LIST_RE.test(s)) return { kind: 'list' };

  const done = s.match(DONE_RE);
  if (done?.[1]) return { kind: 'done', titleFragment: done[1].trim() };

  return null;
}
