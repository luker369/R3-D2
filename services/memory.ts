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

// Module-level cache — avoids a Supabase round trip on every turn.
// Invalidated whenever a new memory is saved.
let memoryCached: string | null = null;

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Load all memories and return them as a formatted string ready to inject
 * into the GPT system prompt. Returns empty string if there are no memories.
 * Result is cached until a new memory is saved.
 */
export async function fetchMemories(): Promise<string> {
  if (memoryCached !== null) return memoryCached;

  const { data, error } = await supabase
    .from(TABLE)
    .select('category, content')
    .order('id', { ascending: true });

  if (error) {
    console.warn('[memory] fetchMemories error:', error.message);
    return '';
  }

  if (!data || data.length === 0) {
    memoryCached = '';
    return '';
  }

  const lines = (data as MemoryEntry[]).map(m => `- [${m.category}] ${m.content}`);
  memoryCached = `Things you remember about the user:\n${lines.join('\n')}`;
  return memoryCached;
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
async function saveMemory(category: string, content: string): Promise<void> {
  const { error } = await supabase.from(TABLE).insert({ category, content });

  if (error) {
    console.warn('[memory] saveMemory error:', error.message);
    return;
  }

  memoryCached = null; // force re-fetch next turn so new memory is included
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
  const prompt = [
    {
      role: 'user' as const,
      content:
        `Given this conversation:\n` +
        `User: "${userText}"\n` +
        `Assistant: "${assistantText}"\n\n` +
        `Does this exchange reveal something DURABLY worth remembering about the user?\n` +
        `Only save if it is a stable personal detail, strong preference, long-term goal, or recurring need.\n` +
        `Do NOT save: session context, one-off requests, things said in passing, or anything that won't matter in a future conversation.\n\n` +
        `If yes, reply with JSON only, no extra text:\n` +
        `{"category": "fact|preference|goal", "content": "one concise sentence"}\n\n` +
        `If nothing is durably worth remembering, reply with the single word: null`,
    },
  ];

  try {
    const result = await getChatResponse(prompt);

    if (!result || result.trim() === 'null') return;

    const parsed: MemoryEntry = JSON.parse(result);

    if (parsed.category && parsed.content) {
      await saveMemory(parsed.category, parsed.content);
      console.log(`[memory] saved: [${parsed.category}] ${parsed.content}`);
    }
  } catch (err) {
    // Non-critical — if extraction fails, the conversation still works fine
    console.warn('[memory] extractAndSaveMemory failed:', err);
  }
}
