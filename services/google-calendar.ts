/**
 * services/google-calendar.ts
 *
 * Reads events from the device calendar (synced with Google Calendar).
 * No OAuth needed — uses expo-calendar with a READ_CALENDAR permission.
 */

import * as Calendar from 'expo-calendar';

let calendarCached: { text: string; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60_000;

let permissionGranted: boolean | null = null;

export async function fetchCalendarContext(daysAhead = 30): Promise<string> {
  if (calendarCached && Date.now() - calendarCached.fetchedAt < CACHE_TTL_MS) {
    return calendarCached.text;
  }

  if (permissionGranted === null) {
    const { status } = await Calendar.requestCalendarPermissionsAsync();
    permissionGranted = status === 'granted';
  }
  if (!permissionGranted) return '';

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
