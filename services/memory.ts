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

const TABLE = 'memory_entries';

// ─── Types ────────────────────────────────────────────────────────────────────

type MemoryEntry = {
  category: string;
  content: string;
};

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

  const { data, error } = await supabase
    .from(TABLE)
    .select('id, category, content')
    .neq('category', 'system')
    .order('id', { ascending: true });

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

  const rows = data as (MemoryEntry & { id: number })[];
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
    await supabase.from(TABLE).insert(entries);
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
 */
export async function saveEntry(category: string, content: string): Promise<void> {
  await saveMemory(category, content);
}

/**
 * Save a single memory entry to Supabase.
 */
const savedThisSession = new Set<string>();

async function saveMemory(category: string, content: string): Promise<void> {
  const key = `${category}::${content.toLowerCase().trim()}`;
  if (savedThisSession.has(key)) return;
  savedThisSession.add(key);

  const { error } = await supabase.from(TABLE).insert({ category, content });

  if (error) {
    console.warn('[memory] saveMemory error:', error.message);
    savedThisSession.delete(key);
    return;
  }

  memoryCached = null;
  systemCached = null;
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
        `If yes, reply with JSON only, no extra text:\n` +
        `{"category": "fact|preference|goal|todo|note", "content": "one concise sentence"}\n\n` +
        `If nothing is worth saving, reply with the single word: null`,
    },
  ];

  try {
    const result = await getChatResponse(prompt, undefined, undefined, 'gpt-5.4-mini');

    if (!result || result.trim() === 'null') return;

    const cleaned = result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (cleaned === 'null') return;

    const parsed: MemoryEntry = JSON.parse(cleaned);

    if (parsed.category && parsed.content) {
      await saveMemory(parsed.category, parsed.content);
      console.log(`[memory] saved: [${parsed.category}] ${parsed.content}`);
    }
  } catch (err) {
    // Non-critical — if extraction fails, the conversation still works fine
    console.warn('[memory] extractAndSaveMemory failed:', err);
  }
}
