/**
 * services/memory.ts
 *
 * Two responsibilities:
 *
 *   fetchMemories        — load all saved memories from Supabase and format them
 *                          as a string to inject into GPT's system prompt
 *
 *   extractAndSaveMemory — after each conversation turn, ask GPT whether anything
 *                          is worth remembering. If yes, save it to Supabase.
 *                          Runs in the background — does not block the voice loop.
 */

import { supabase } from './supabase';
import { getChatResponse } from './openai';
import { ENABLE_MEMORY_EXTRACTION } from '@/lib/feature-flags';

const TABLE = 'memory_entries';

// ─── Types ────────────────────────────────────────────────────────────────────

type MemoryEntry = {
  category: string;
  content: string;
};

// All new columns are optional in JS so the existing call shape (just
// {category, content}) keeps working — the DB defaults fill the rest.
export type SaveOptions = {
  title?: string;
  source?: 'voice-cmd' | 'voice-explicit' | 'auto-extract' | 'compress' | 'system';
  confidence?: 'low' | 'medium' | 'high';
  project?: string;
  tags?: string[];
  importance?: number; // clamped to 1..5
  reason?: string;
};

// Columns selected for user-visible memory queries. Wider than what we used to
// pull, but cheap — the table is small and the new fields drive ordering and
// spoken summaries.
const MEMORY_COLUMNS =
  'id, category, content, title, source, confidence, project, tags, importance, reason, is_active, created_at, updated_at';

function clampImportance(v: any): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(1, Math.min(5, Math.round(v)));
}

function sanitizeTags(v: any): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const cleaned = v
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t.length <= 40);
  return cleaned.length > 0 ? cleaned.slice(0, 10) : undefined;
}

function buildInsertPayload(
  category: string,
  content: string,
  opts?: SaveOptions,
): Record<string, any> {
  const payload: Record<string, any> = { category, content };
  if (!opts) return payload;
  if (opts.title) payload.title = opts.title;
  if (opts.source) payload.source = opts.source;
  if (opts.confidence) payload.confidence = opts.confidence;
  if (opts.project) payload.project = opts.project;
  const tags = sanitizeTags(opts.tags);
  if (tags) payload.tags = tags;
  const importance = clampImportance(opts.importance);
  if (importance != null) payload.importance = importance;
  if (opts.reason) payload.reason = opts.reason;
  // Stamp updated_at on each write so the recency-aware ordering reflects
  // intent (the DB default only fires on initial insert).
  payload.updated_at = new Date().toISOString();
  return payload;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let memoryCached: string | null = null;
let systemCached: Record<string, string> | null = null;

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Load all memories and return them as a formatted string ready to inject
 * into the GPT system prompt. Returns empty string if there are no memories.
 * Result is cached until a new memory is saved.
 */
export async function fetchSystemSettings(): Promise<Record<string, string>> {
  if (systemCached !== null) return systemCached;

  const { data, error } = await supabase
    .from(TABLE)
    .select('category, content')
    .eq('category', 'system')
    .order('id', { ascending: true });

  if (error || !data) { systemCached = {}; return {}; }

  const settings: Record<string, string> = {};
  for (const row of data as MemoryEntry[]) {
    const [key, ...rest] = row.content.split('=');
    if (key && rest.length) settings[key.trim()] = rest.join('=').trim();
  }
  systemCached = settings;
  console.log('[memory] loaded system settings:', settings);
  return settings;
}

export async function saveSystemSetting(key: string, value: string): Promise<void> {
  // Upsert: delete existing entry for this key then insert fresh
  await supabase.from(TABLE).delete().eq('category', 'system').like('content', `${key}=%`);
  const { error } = await supabase.from(TABLE).insert({ category: 'system', content: `${key}=${value}` });
  if (error) { console.warn('[memory] saveSystemSetting error:', error.message); return; }
  systemCached = null;
  memoryCached = null;
  console.log(`[memory] system setting saved: ${key}=${value}`);
}

const COMPRESS_THRESHOLD = 25;

export async function fetchMemories(): Promise<string> {
  if (memoryCached !== null) return memoryCached;

  // .neq('is_active', false) keeps both true and null active — defensive
  // against legacy rows that pre-date the column. Ordering: highest
  // importance first, then most recently updated, then newest id as a stable
  // tiebreaker. nullsFirst:false so legacy rows with null importance/updated_at
  // sink to the bottom rather than displacing real data.
  const { data, error } = await supabase
    .from(TABLE)
    .select(MEMORY_COLUMNS)
    .neq('category', 'system')
    .neq('is_active', false)
    .order('importance', { ascending: false, nullsFirst: false })
    .order('updated_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false });

  if (error) {
    console.warn('[memory] fetchMemories error:', error.message);
    return '';
  }

  if (!data || data.length === 0) {
    console.warn('[memory] fetchMemories returned 0 rows — check Supabase RLS SELECT policy');
    memoryCached = '';
    return '';
  }

  if (data.length >= COMPRESS_THRESHOLD) {
    compressMemories(data as any[]).catch(() => {});
  }

  const rows = data as MemoryRow[];
  const todos = rows.filter(m => m.category === 'todo');
  const rest  = rows.filter(m => m.category !== 'todo');

  const sections: string[] = [];

  if (todos.length > 0) {
    sections.push(`Tasks (${todos.length} total):\n${todos.map(m => `- ${m.content}`).join('\n')}`);
  }
  if (rest.length > 0) {
    sections.push(`Other things you know about the user:\n${rest.map(m => `- [${m.category}] ${m.content}`).join('\n')}`);
  }

  memoryCached = sections.join('\n\n');
  console.log(`[memory] loaded ${rows.length} memories (${todos.length} tasks)`);
  return memoryCached;
}

async function compressMemories(rows: { id: number; category: string; content: string }[]): Promise<void> {
  console.log(`[memory] compressing ${rows.length} entries…`);
  const formatted = rows.map(r => `[${r.category}] ${r.content}`).join('\n');

  const prompt = [{
    role: 'user' as const,
    content:
      `Clean up this memory list for a personal AI assistant. ` +
      `Merge duplicates, remove noise and meta-observations, keep only concrete facts about the user.\n` +
      `Return a JSON array only, no extra text:\n` +
      `[{"category":"fact|preference|goal|todo|note","content":"one concise sentence"}]\n\n` +
      `Memories to clean:\n${formatted}`,
  }];

  try {
    const result = await getChatResponse(prompt, undefined, undefined, 'gpt-5.4');
    const cleaned = result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const entries: MemoryEntry[] = JSON.parse(cleaned);
    if (!Array.isArray(entries) || entries.length === 0) return;

    const ids = rows.map(r => r.id);
    await supabase.from(TABLE).delete().in('id', ids);
    // Tag compressed inserts so we can tell merged entries apart from raw saves.
    // Compression is the only path that hard-deletes inputs (it's an internal
    // cleanup, not a user-visible forget) — see deleteMostRecentMemory and
    // deleteMemoriesByTopic for the soft-delete paths used by voice commands.
    const stamped = entries.map((e) =>
      buildInsertPayload(e.category, e.content, { source: 'compress', confidence: 'high' }),
    );
    await supabase.from(TABLE).insert(stamped);
    memoryCached = null;
    console.log(`[memory] compressed to ${entries.length} entries`);
  } catch (err) {
    console.warn('[memory] compression failed:', err);
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────────

/**
 * Save an explicitly triggered entry with a given category.
 * Categories: 'note' | 'task' | 'decision' | 'summary'
 *
 * This entry point is only hit from the voice-command save block, so we tag
 * source/confidence/importance with that intent. Callers may pass extra opts
 * (project, tags, title, etc.) which override these defaults.
 */
export async function saveEntry(
  category: string,
  content: string,
  opts: SaveOptions = {},
): Promise<void> {
  await saveMemory(category, content, {
    source: 'voice-cmd',
    confidence: 'high',
    importance: 4,
    ...opts,
  });
}

/**
 * Save a single memory entry to Supabase.
 */
const savedThisSession = new Set<string>();
// Cap the dedup set so a long-running session doesn't grow it forever. The
// dedup is a best-effort "already wrote this verbatim moments ago" guard, not
// a correctness invariant — dropping the oldest 200 entries is fine.
const SAVED_SESSION_MAX = 500;

// Tracks the most recently saved entry so a follow-up "forget that" has a clear
// referent. Cleared on app restart — the deleteMostRecent path falls back to
// the highest-id row in the DB when this is null.
let lastSaved: { id: number; category: string; content: string } | null = null;

async function saveMemory(
  category: string,
  content: string,
  opts?: SaveOptions,
): Promise<void> {
  const key = `${category}::${content.toLowerCase().trim()}`;
  if (savedThisSession.has(key)) return;
  if (savedThisSession.size >= SAVED_SESSION_MAX) {
    console.log('[memory] savedThisSession cap hit; clearing');
    savedThisSession.clear();
  }
  savedThisSession.add(key);

  const payload = buildInsertPayload(category, content, opts);
  const { data, error } = await supabase
    .from(TABLE)
    .insert(payload)
    .select('id')
    .single();

  if (error) {
    console.warn('[memory] saveMemory error:', error.message);
    savedThisSession.delete(key);
    return;
  }

  if (data?.id != null && category !== 'system') {
    lastSaved = { id: data.id, category, content };
  }
  memoryCached = null;
  systemCached = null;
}

// ─── List + Delete (voice-driven review/deletion commands) ────────────────────

export type MemoryRow = {
  id: number;
  category: string;
  content: string;
  title?: string | null;
  source?: string | null;
  confidence?: string | null;
  project?: string | null;
  tags?: string[] | null;
  importance?: number | null;
  reason?: string | null;
  is_active?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
};

/**
 * Fetch user-visible memory rows (excludes 'system' settings, excludes soft-
 * deleted). Optional filters compose: `project` is exact-match, `tags` is
 * any-overlap, `topic` is case-insensitive substring against content. Ordering
 * matches fetchMemories (importance → updated_at → id) so spoken readouts and
 * model-injected memory agree on which entries are "top".
 */
export async function listMemories(opts: {
  topic?: string;
  project?: string;
  tags?: string[];
  limit?: number;
} = {}): Promise<MemoryRow[]> {
  const limit = opts.limit ?? 50;
  let q = supabase
    .from(TABLE)
    .select(MEMORY_COLUMNS)
    .neq('category', 'system')
    .neq('is_active', false)
    .order('importance', { ascending: false, nullsFirst: false })
    .order('updated_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .limit(limit);

  if (opts.project) q = q.eq('project', opts.project);
  if (opts.tags && opts.tags.length > 0) q = q.overlaps('tags', opts.tags);

  const { data, error } = await q;

  if (error) {
    console.warn('[memory] listMemories error:', error.message);
    return [];
  }
  const rows = (data ?? []) as MemoryRow[];
  if (!opts.topic) return rows;
  const needle = opts.topic.toLowerCase();
  return rows.filter((r) => r.content.toLowerCase().includes(needle));
}

/**
 * Voice-friendly summary. Prefers `title` over the full content sentence so
 * spoken readouts stay short; falls back to content for legacy rows. Uses
 * sentence-style separators so TTS reads with natural pauses; caps spoken
 * count and tells the user how many more exist.
 */
export function formatMemoriesForSpeech(rows: MemoryRow[], spokenLimit = 5): string {
  if (rows.length === 0) return '';
  const head = rows
    .slice(0, spokenLimit)
    .map((r) => (r.title?.trim() || r.content).replace(/\.+$/, ''))
    .join('. ');
  const overflow = rows.length - spokenLimit;
  return overflow > 0 ? `${head}. Plus ${overflow} more.` : `${head}.`;
}

/**
 * Soft-delete the most recently saved entry. Prefers the in-process `lastSaved`
 * pointer (set by saveMemory). Falls back to the highest-id active row when
 * lastSaved is null (app restart). Updates is_active=false + updated_at so
 * the row drops out of fetchMemories/listMemories but remains recoverable in
 * the database for manual triage.
 */
export async function deleteMostRecentMemory(): Promise<MemoryRow | null> {
  const stamp = new Date().toISOString();

  if (lastSaved) {
    const target = lastSaved;
    const { error } = await supabase
      .from(TABLE)
      .update({ is_active: false, updated_at: stamp })
      .eq('id', target.id);
    if (error) {
      console.warn('[memory] deleteMostRecentMemory (tracked) error:', error.message);
      return null;
    }
    lastSaved = null;
    memoryCached = null;
    return { id: target.id, category: target.category, content: target.content };
  }

  const { data, error } = await supabase
    .from(TABLE)
    .select(MEMORY_COLUMNS)
    .neq('category', 'system')
    .neq('is_active', false)
    .order('id', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const row = data[0] as MemoryRow;
  const upd = await supabase
    .from(TABLE)
    .update({ is_active: false, updated_at: stamp })
    .eq('id', row.id);
  if (upd.error) {
    console.warn('[memory] deleteMostRecentMemory (fallback) error:', upd.error.message);
    return null;
  }
  memoryCached = null;
  return row;
}

/**
 * Soft-delete every active non-system entry whose content matches `topic`
 * (case-insensitive substring). Returns count + a short preview of what was
 * removed for spoken confirmation. Rows remain in the DB with is_active=false
 * for recoverability.
 */
export async function deleteMemoriesByTopic(topic: string): Promise<{ deleted: number; preview: string[] }> {
  const matches = await listMemories({ topic });
  if (matches.length === 0) return { deleted: 0, preview: [] };
  const ids = matches.map((m) => m.id);
  const { error } = await supabase
    .from(TABLE)
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .in('id', ids);
  if (error) {
    console.warn('[memory] deleteMemoriesByTopic error:', error.message);
    return { deleted: 0, preview: [] };
  }
  if (lastSaved && ids.includes(lastSaved.id)) lastSaved = null;
  memoryCached = null;
  return {
    deleted: matches.length,
    preview: matches.slice(0, 3).map((m) => m.title?.trim() || m.content),
  };
}

// ─── Extract + Save ───────────────────────────────────────────────────────────

/**
 * Ask GPT to decide whether anything from this exchange is worth remembering.
 * If yes, save it to Supabase. If no, do nothing.
 *
 * This is called after the assistant has already spoken — it runs in the
 * background and does not add latency to the voice loop. Fire and forget.
 */
export async function extractAndSaveMemory(
  userText: string,
  assistantText: string
): Promise<void> {
  if (!ENABLE_MEMORY_EXTRACTION) return;
  const existing = memoryCached ?? '';
  const prompt = [
    {
      role: 'user' as const,
      content:
        `Given this conversation:\n` +
        `User: "${userText}"\n` +
        `Assistant: "${assistantText}"\n\n` +
        (existing ? `Already saved memories (DO NOT duplicate anything already listed here):\n${existing}\n\n` : '') +
        `Is there ONE specific, concrete fact worth saving — a real name, an explicit stated preference, a concrete task with detail, or a specific long-term goal?\n` +
        `Skip everything else: UI observations, app behavior, conversation meta-commentary, vague generalizations, anything about how the assistant works, and things said in passing.\n` +
        `Default to null. Only save if it is unmistakably about the user as a person AND not already captured above.\n\n` +
        `If yes, reply with JSON only, no extra text. Only "category" and "content" are required; the rest are optional and may be omitted:\n` +
        `{\n` +
        `  "category": "fact|preference|goal|todo|note",\n` +
        `  "content": "one concise sentence",\n` +
        `  "title": "1-5 word label (optional)",\n` +
        `  "project": "project name if clearly tied to one (optional)",\n` +
        `  "tags": ["lowercase", "topic", "tags"] (optional, max 10),\n` +
        `  "importance": 1-5 (optional, default 3; 5 = critical, 1 = trivia),\n` +
        `  "confidence": "low|medium|high" (optional, default medium),\n` +
        `  "reason": "one short clause: why this is worth remembering"\n` +
        `}\n\n` +
        `If nothing is worth saving, reply with the single word: null`,
    },
  ];

  try {
    // Fire-and-forget caller means nothing will ever time out this call
    // for us — if OpenAI hangs, the closure (and the prompt) leaks. Race
    // it with a 20s timeout so each extraction has a hard ceiling.
    const result = await Promise.race([
      getChatResponse(prompt, undefined, undefined, 'gpt-5.4-mini'),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('extractAndSaveMemory timeout (20s)')), 20_000),
      ),
    ]);

    if (!result || result.trim() === 'null') return;

    const cleaned = result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (cleaned === 'null') return;

    const parsed: any = JSON.parse(cleaned);

    if (parsed && parsed.category && parsed.content) {
      // Pull through the optional enrichment fields. saveMemory's helper
      // already sanitizes tags (drops non-arrays, bounds length) and clamps
      // importance to 1..5, so passing through raw model output is safe.
      const opts: SaveOptions = {
        source: 'auto-extract',
        confidence: parsed.confidence === 'low' || parsed.confidence === 'high' ? parsed.confidence : 'medium',
        title: typeof parsed.title === 'string' ? parsed.title : undefined,
        project: typeof parsed.project === 'string' ? parsed.project : undefined,
        tags: parsed.tags,
        importance: parsed.importance,
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      };
      await saveMemory(parsed.category, parsed.content, opts);
      console.log(
        `[memory] saved: [${parsed.category}${opts.project ? `/${opts.project}` : ''}] ${parsed.content}`,
      );
    }
  } catch (err) {
    // Non-critical — if extraction fails, the conversation still works fine
    console.warn('[memory] extractAndSaveMemory failed:', err);
  }
}
