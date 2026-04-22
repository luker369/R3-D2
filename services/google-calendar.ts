/**
 * services/google-calendar.ts
 *
 * Reads and writes events on the device calendar (synced with Google Calendar).
 * No OAuth needed — uses expo-calendar with READ_CALENDAR / WRITE_CALENDAR permissions.
 */

import * as Calendar from 'expo-calendar';

let calendarCached: { text: string; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60_000;

let permissionGranted: boolean | null = null;

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted === null) {
    const { status } = await Calendar.requestCalendarPermissionsAsync();
    permissionGranted = status === 'granted';
  }
  return permissionGranted;
}

export async function fetchCalendarContext(daysAhead = 30): Promise<string> {
  if (calendarCached && Date.now() - calendarCached.fetchedAt < CACHE_TTL_MS) {
    return calendarCached.text;
  }

  if (!(await ensurePermission())) return '';

  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const ids = calendars.map(c => c.id);
  if (ids.length === 0) return '';

  const now   = new Date();
  const later = new Date(now.getTime() + daysAhead * 24 * 60 * 60_000);

  const events = await Calendar.getEventsAsync(ids, now, later);

  if (events.length === 0) {
    const text = 'The user has no upcoming calendar events in the next 30 days.';
    calendarCached = { text, fetchedAt: Date.now() };
    return text;
  }

  const lines = events
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
    .slice(0, 20)
    .map(e => formatEvent(e));

  const text = `Upcoming calendar events (next ${daysAhead} days, ${events.length} total):\n${lines.join('\n')}`;
  calendarCached = { text, fetchedAt: Date.now() };
  console.log(`[calendar] loaded ${events.length} events`);
  return text;
}

export function invalidateCalendarCache(): void {
  calendarCached = null;
}

export type CalEvent = {
  id: string;
  title: string;
  startISO: string;
  endISO: string;
  allDay: boolean;
  location?: string;
};

/**
 * Midnight-to-midnight local-day window of events. Used by the daily briefing
 * synthesis — separate code path from fetchCalendarContext so the briefing
 * gets structured events rather than the pre-formatted 30-day string.
 */
export async function fetchTodayEvents(): Promise<CalEvent[]> {
  const now = new Date();
  return fetchEventsInWindow(startOfLocalDay(now), endOfLocalDay(now));
}

export async function fetchTomorrowEvents(): Promise<CalEvent[]> {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  return fetchEventsInWindow(startOfLocalDay(t), endOfLocalDay(t));
}

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

async function fetchEventsInWindow(start: Date, end: Date): Promise<CalEvent[]> {
  if (!(await ensurePermission())) return [];
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const ids = calendars.map(c => c.id);
  if (ids.length === 0) return [];
  const events = await Calendar.getEventsAsync(ids, start, end);
  return events
    .map(e => ({
      id: e.id,
      title: e.title ?? 'Untitled',
      startISO: new Date(e.startDate).toISOString(),
      endISO: new Date(e.endDate).toISOString(),
      allDay: !!e.allDay,
      location: e.location || undefined,
    }))
    .sort((a, b) => a.startISO.localeCompare(b.startISO));
}

export type CreateEventInput = {
  title: string;
  startDate: Date;
  endDate: Date;
  allDay?: boolean;
  location?: string;
  notes?: string;
};

export type CreateEventResult =
  | { ok: true; eventId: string; calendarTitle: string }
  | { ok: false; reason: 'permission' | 'no_calendar' | 'error'; message: string };

export type CalendarWritable =
  | { ok: true }
  | { ok: false; reason: 'permission' | 'no_calendar' };

/**
 * Preflight check used by the two-turn confirmation flow so we don't summarize
 * an event we can't actually save. Triggers the Android runtime prompt the
 * same way createCalendarEvent does — just earlier in the turn.
 */
export async function ensureCalendarWritable(): Promise<CalendarWritable> {
  if (!(await ensurePermission())) return { ok: false, reason: 'permission' };
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const writable = calendars.filter(c => c.allowsModifications);
  if (writable.length === 0) return { ok: false, reason: 'no_calendar' };
  return { ok: true };
}

export async function createCalendarEvent(input: CreateEventInput): Promise<CreateEventResult> {
  if (!(await ensurePermission())) {
    return { ok: false, reason: 'permission', message: 'Calendar permission denied.' };
  }

  try {
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const writable = calendars.filter(c => c.allowsModifications);
    if (writable.length === 0) {
      return { ok: false, reason: 'no_calendar', message: 'No writable calendar found.' };
    }

    // Prefer the primary Google calendar, then any "owner" calendar, else the first writable.
    const isOwner = (c: Calendar.Calendar) => String(c.accessLevel).toLowerCase() === 'owner';
    const preferred =
      writable.find(c => isOwner(c) && c.source?.name?.toLowerCase().includes('google')) ??
      writable.find(isOwner) ??
      writable[0];

    const eventId = await Calendar.createEventAsync(preferred.id, {
      title: input.title,
      startDate: input.startDate,
      endDate: input.endDate,
      allDay: input.allDay ?? false,
      location: input.location,
      notes: input.notes,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    invalidateCalendarCache();
    console.log(`[calendar] created event "${input.title}" on "${preferred.title}" id=${eventId}`);
    return { ok: true, eventId, calendarTitle: preferred.title };
  } catch (e: any) {
    console.warn('[calendar] createEvent failed:', e);
    return { ok: false, reason: 'error', message: e?.message ?? String(e) };
  }
}

function formatEvent(e: Calendar.Event): string {
  const title = e.title ?? 'Untitled event';
  const start = new Date(e.startDate);
  const end   = new Date(e.endDate);
  const dateStr = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const loc = e.location ? ` @ ${e.location}` : '';

  if (e.allDay) return `- ${title}: ${dateStr} (all day)${loc}`;

  const startTime = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const endTime   = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `- ${title}: ${dateStr} ${startTime}–${endTime}${loc}`;
}
