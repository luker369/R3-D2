/**
 * services/reminders.ts
 *
 * Thin CRUD over the `reminders` table. No scheduling, no notifications —
 * just persist what the user asked and read it back. Mirrors services/tasks.ts.
 *
 *   createReminder       — insert a pending reminder at a given time
 *   listTodayReminders   — return all of today's pending reminders, time-sorted
 *
 * Firing / local notifications intentionally NOT here. See notes at the
 * bottom of this file for how to add Notifee-backed alarms later.
 */

import { supabase } from './supabase';

const TABLE = 'reminders';

export type ReminderStatus = 'pending' | 'fired' | 'cancelled';

export type ReminderRow = {
  id: number;
  created_at: string;
  title: string;
  remind_at: string; // ISO timestamp
  status: ReminderStatus;
  task_id: number | null;
};

export async function createReminder(
  title: string,
  remindAt: Date,
  taskId: number | null = null,
): Promise<ReminderRow | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      title,
      remind_at: remindAt.toISOString(),
      task_id: taskId,
    })
    .select()
    .single();
  if (error) {
    console.warn('[reminders] create error:', error.message);
    return null;
  }
  console.log('[reminders] created:', data?.id, data?.title, 'at', data?.remind_at);
  return data as ReminderRow;
}

/**
 * All pending reminders scheduled for today (local day, midnight to midnight).
 * Includes already-past reminders for today since there's no firing mechanism
 * yet — a pending reminder at 9 AM when it's 10 AM is still "today's reminder".
 */
export async function listTodayReminders(): Promise<ReminderRow[]> {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', 'pending')
    .gte('remind_at', startOfDay.toISOString())
    .lte('remind_at', endOfDay.toISOString())
    .order('remind_at', { ascending: true });
  if (error) {
    console.warn('[reminders] list error:', error.message);
    return [];
  }
  return (data ?? []) as ReminderRow[];
}

/*
 * Firing later — Notifee is already linked (see services/foreground-service.ts).
 * Adding scheduled local notifications would require:
 *   1. notifee.createTriggerNotification(notification, { type: TIMESTAMP, timestamp })
 *      at reminder creation time.
 *   2. Android 12+ SCHEDULE_EXACT_ALARM permission in AndroidManifest + runtime
 *      prompt via notifee.openAlarmPermissionSettings().
 *   3. A boot-receiver / app-open reconciler to re-register triggers that were
 *      dropped by the OS across reboots.
 * None of that needs to happen before the DB write is trusted. Do it after.
 */
