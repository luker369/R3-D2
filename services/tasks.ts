/**
 * services/tasks.ts
 *
 * Thin CRUD over the `tasks` table. Mirrors services/memory.ts in style —
 * plain async functions, no caching, no abstraction layer. Three operations:
 *
 *   createTask             — insert a new open task
 *   listOpenTasks          — return the most recent N open tasks
 *   completeTaskByTitle    — fuzzy-match by title fragment, flip to 'done'
 *
 * Reminders / due-date scheduling / calendar sync intentionally NOT here.
 */

import { supabase } from './supabase';

const TABLE = 'tasks';

export type TaskStatus = 'open' | 'done';
export type TaskPriority = 'low' | 'normal' | 'high';

export type TaskRow = {
  id: number;
  created_at: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  source: string;
  notes: string | null;
};

type CreateOpts = {
  priority?: TaskPriority;
  due_at?: string | null;
  notes?: string | null;
  source?: string;
};

export async function createTask(title: string, opts: CreateOpts = {}): Promise<TaskRow | null> {
  const row = {
    title,
    priority: opts.priority ?? 'normal',
    due_at: opts.due_at ?? null,
    notes: opts.notes ?? null,
    source: opts.source ?? 'voice',
  };
  const { data, error } = await supabase
    .from(TABLE)
    .insert(row)
    .select()
    .single();
  if (error) {
    console.warn('[tasks] create error:', error.message);
    return null;
  }
  console.log('[tasks] created:', data?.id, data?.title);
  return data as TaskRow;
}

export async function listOpenTasks(limit = 10): Promise<TaskRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[tasks] list error:', error.message);
    return [];
  }
  return (data ?? []) as TaskRow[];
}

/**
 * Find the most recent open task whose title contains `titleFragment`
 * (case-insensitive) and mark it done. Returns the updated row, or null if
 * no match / update failed.
 */
export async function completeTaskByTitle(titleFragment: string): Promise<TaskRow | null> {
  const frag = titleFragment.trim();
  if (!frag) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', 'open')
    .ilike('title', `%${frag}%`)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn('[tasks] complete lookup error:', error.message);
    return null;
  }
  if (!data || data.length === 0) return null;
  const target = data[0] as TaskRow;
  const { error: upErr } = await supabase
    .from(TABLE)
    .update({ status: 'done' })
    .eq('id', target.id);
  if (upErr) {
    console.warn('[tasks] complete update error:', upErr.message);
    return null;
  }
  console.log('[tasks] completed:', target.id, target.title);
  return { ...target, status: 'done' };
}
