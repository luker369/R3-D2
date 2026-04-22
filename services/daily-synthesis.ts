/**
 * services/daily-synthesis.ts
 *
 * Hard-wired daily-briefing orchestration. One command, one handler, one LLM
 * call. Not a general agent framework — just a careful join over the existing
 * integrations (calendar, gmail, tasks, reminders, memory) with a shaped
 * synthesis prompt.
 *
 *   gatherDailyContext  — parallel fan-out with Promise.allSettled so a
 *                         single slow/broken source doesn't block the briefing.
 *   synthesizeDaily     — single LLM call with the shaped prompt. Returns the
 *                         spoken-natural briefing string.
 *   runDailySynthesis   — glue. This is what the voice hook calls.
 */

import {
  fetchTodayEvents,
  fetchTomorrowEvents,
  type CalEvent,
} from './google-calendar';
import {
  fetchRecentEmails,
  fetchUnreadEmails,
  type GmailMessage,
} from './gmail';
import { listOpenTasks, type TaskRow } from './tasks';
import { listTodayReminders, type ReminderRow } from './reminders';
import { fetchMemories } from './memory';
import { getChatResponse } from './openai';

export type DailyContextPacket = {
  nowISO: string;
  todayHuman: string;
  calendar: { today: CalEvent[]; tomorrow: CalEvent[] };
  emails: { unread: GmailMessage[]; recent: GmailMessage[] };
  tasks: TaskRow[];
  reminders: ReminderRow[];
  memoriesText: string;
};

export async function gatherDailyContext(): Promise<DailyContextPacket> {
  const now = new Date();

  const [calToday, calTomorrow, unread, recent, tasks, reminders, mems] =
    await Promise.allSettled([
      fetchTodayEvents(),
      fetchTomorrowEvents(),
      fetchUnreadEmails(5),
      fetchRecentEmails(5),
      listOpenTasks(20),
      listTodayReminders(),
      fetchMemories(),
    ]);

  const pick = <T>(r: PromiseSettledResult<T>, source: string, fallback: T): T => {
    if (r.status === 'fulfilled') return r.value;
    console.warn(`[synthesis] source failed: ${source}:`, r.reason);
    return fallback;
  };

  return {
    nowISO: now.toISOString(),
    todayHuman: now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }),
    calendar: {
      today: pick(calToday, 'calendar-today', []),
      tomorrow: pick(calTomorrow, 'calendar-tomorrow', []),
    },
    emails: {
      unread: pick(unread, 'email-unread', []),
      recent: pick(recent, 'email-recent', []),
    },
    tasks: pick(tasks, 'tasks', []),
    reminders: pick(reminders, 'reminders', []),
    memoriesText: pick(mems, 'memory', ''),
  };
}

function formatEvents(events: CalEvent[]): string {
  if (events.length === 0) return '(none)';
  return events
    .map(e => {
      const s = new Date(e.startISO);
      const en = new Date(e.endISO);
      const loc = e.location ? ` @ ${e.location}` : '';
      if (e.allDay) return `- ${e.title} (all day)${loc}`;
      const t = (d: Date) =>
        d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return `- ${e.title}: ${t(s)}–${t(en)}${loc}`;
    })
    .join('\n');
}

function formatEmails(emails: GmailMessage[]): string {
  if (emails.length === 0) return '(none)';
  return emails
    .map(e => {
      const when = new Date(e.date).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      const acc = e.account ? ` [${e.account}]` : '';
      const unreadTag = e.unread ? ' [unread]' : '';
      return `- From: ${e.from}${acc}${unreadTag}\n  Subject: ${e.subject}\n  When: ${when}\n  Snippet: ${e.snippet}`;
    })
    .join('\n');
}

function formatTasks(tasks: TaskRow[]): string {
  if (tasks.length === 0) return '(none)';
  const now = Date.now();
  return tasks
    .map(t => {
      const ageDays = Math.floor((now - new Date(t.created_at).getTime()) / 86_400_000);
      const ageStr = ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays}d ago`;
      const due = t.due_at
        ? ` (due ${new Date(t.due_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
        : '';
      const pri = t.priority !== 'normal' ? ` [${t.priority} priority]` : '';
      return `- ${t.title}${pri}${due} (created ${ageStr})`;
    })
    .join('\n');
}

function formatReminders(reminders: ReminderRow[]): string {
  if (reminders.length === 0) return '(none)';
  return reminders
    .map(r => {
      const t = new Date(r.remind_at).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      });
      return `- ${t}: ${r.title}`;
    })
    .join('\n');
}

function buildPrompt(p: DailyContextPacket): string {
  return (
    `You are the user's assistant producing a short daily briefing that will be spoken aloud.\n` +
    `Today is ${p.todayHuman}. Current time: ${p.nowISO}.\n\n` +
    `Synthesize — don't enumerate. Deliver four things, flowing as a briefing, not a checklist:\n` +
    `  1. Top 3 priorities for today — the things that actually matter.\n` +
    `  2. Anything urgent (deadline today/tomorrow, person waiting, time-sensitive).\n` +
    `  3. One or two things that can wait.\n` +
    `  4. Exactly one recommended next action — concrete, actionable, the one thing to do first.\n\n` +
    `Rules:\n` +
    `- 4 to 8 sentences total. Longer is worse.\n` +
    `- No bullets, no markdown, no list markers. Natural spoken English.\n` +
    `- Reference real names, subjects, and event titles from the context. Never paraphrase to "a meeting" or "an email".\n` +
    `- Rank by combined signal: deadline proximity, explicit priority, person waiting, recency.\n` +
    `- Skip noise — routine unread emails, low-priority dateless tasks, expired reminders.\n` +
    `- Don't invent. Every claim must trace to the context below. If the context is thin, say so briefly and stop.\n` +
    `- If a section has nothing, fold it in or skip it — don't pad. "No urgent items" is fine; filler is not.\n` +
    `- Lead with the most load-bearing thing. Speak like a capable human briefing a busy person.\n\n` +
    `--- CONTEXT ---\n\n` +
    `Calendar today:\n${formatEvents(p.calendar.today)}\n\n` +
    `Calendar tomorrow (for urgency judgments, not to brief):\n${formatEvents(p.calendar.tomorrow)}\n\n` +
    `Unread emails (top 5):\n${formatEmails(p.emails.unread)}\n\n` +
    `Recent inbox (for continuity, already seen):\n${formatEmails(p.emails.recent)}\n\n` +
    `Open tasks (newest first, up to 20):\n${formatTasks(p.tasks)}\n\n` +
    `Today's reminders:\n${formatReminders(p.reminders)}\n\n` +
    `Recent notes, decisions, and things you know about the user:\n${p.memoriesText || '(none)'}\n\n` +
    `--- END CONTEXT ---\n\n` +
    `Now give the briefing, spoken-natural, 4 to 8 sentences. Start immediately — no preamble.`
  );
}

export async function synthesizeDaily(packet: DailyContextPacket): Promise<string> {
  const prompt = buildPrompt(packet);
  const reply = await getChatResponse(
    [{ role: 'user', content: prompt }],
    undefined,
    undefined,
    'gpt-5.4-mini',
  );
  return reply.trim();
}

export async function runDailySynthesis(): Promise<string> {
  const packet = await gatherDailyContext();
  console.log(
    `[synthesis] packet: ${packet.calendar.today.length} cal today / ` +
      `${packet.calendar.tomorrow.length} cal tomorrow, ` +
      `${packet.emails.unread.length} unread / ${packet.emails.recent.length} recent, ` +
      `${packet.tasks.length} tasks, ${packet.reminders.length} reminders, ` +
      `${packet.memoriesText ? 'memories present' : 'no memories'}`,
  );
  return synthesizeDaily(packet);
}
