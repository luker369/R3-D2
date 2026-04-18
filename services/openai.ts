/**
 * services/openai.ts
 *
 * Three responsibilities:
 *   transcribeAudio   — sends a local audio file to Whisper, returns transcript text
 *   getChatResponse   — sends conversation history to GPT, returns the reply
 *   synthesizeSpeech  — sends text to OpenAI TTS, saves MP3 to cache, returns local URI
 *
 * Raw fetch is used instead of the openai npm package to avoid Node.js polyfill
 * issues in React Native / Hermes.
 *
 * API key: set EXPO_PUBLIC_OPENAI_API_KEY in your .env file.
 * Expo inlines all EXPO_PUBLIC_* vars at Metro bundle time — no extra package needed.
 */

import * as FileSystem from 'expo-file-system/legacy';

const API_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? '';
const BASE = 'https://api.openai.com/v1';

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}


type ImagePart = { type: 'image_url'; image_url: { url: string; detail: 'auto' } };
type TextPart  = { type: 'text'; text: string };

/** A single turn in the conversation history sent to GPT. */
export type Message = {
  role: 'user' | 'assistant' | 'system';
  content: string | (TextPart | ImagePart)[];
};

// ─── Whisper STT ──────────────────────────────────────────────────────────────

/**
 * Transcribe a local audio file using OpenAI Whisper.
 * expo-audio records to AAC/M4A on Android, which Whisper accepts natively.
 *
 * React Native's FormData accepts an object literal with uri/type/name to upload
 * a local file — this differs from browser FormData behavior.
 */
export async function transcribeAudio(audioUri: string): Promise<string> {
  const formData = new FormData();

  formData.append('file', {
    uri: audioUri,
    type: 'audio/m4a',
    name: 'recording.m4a',
  } as any);
  formData.append('model', 'whisper-1');
  formData.append('language', 'en');
  formData.append('temperature', '0');
  formData.append('prompt', 'Talking to R3-D2, a personal voice assistant. Conversational English.');
  formData.append('response_format', 'verbose_json');

  const res = await withRetry(() => fetchWithTimeout(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: formData,
  }, 15_000));

  if (!res.ok) throw new Error(`Whisper error ${res.status}: ${await res.text()}`);

  const json = await res.json();

  // Reject if Whisper thinks there was no speech
  const segments: { no_speech_prob: number }[] = json.segments ?? [];
  const avgNoSpeech = segments.length
    ? segments.reduce((sum, s) => sum + s.no_speech_prob, 0) / segments.length
    : 0;
  if (avgNoSpeech > 0.35) return '';
  // Also reject if any single segment is highly confident there was no speech
  if (segments.some(s => s.no_speech_prob > 0.8)) return '';

  return deduplicateTranscript((json.text as string).trim());
}

/**
 * Whisper sometimes loops — repeating the last clause several times.
 * Split on sentence/clause boundaries and drop consecutive duplicates.
 */
function deduplicateTranscript(text: string): string {
  const parts = text.split(/(?<=[.!?,])\s+/);
  const out: string[] = [];
  for (const part of parts) {
    const norm = part.toLowerCase().trim();
    if (!norm) continue;
    if (out.length === 0 || norm !== out[out.length - 1].toLowerCase().trim()) {
      out.push(part);
    }
  }
  return out.join(' ').trim();
}

// ─── GPT Chat ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a capable, intelligent voice assistant. Accuracy is non-negotiable — never fabricate facts, invent details, or speculate beyond what you actually know. ' +
  'If you are uncertain, say so plainly in one sentence. Do not fill uncertainty with plausible-sounding guesses. ' +
  'Your tone is confident and direct, with a subtle edge of a seasoned commander — but never let personality get in the way of accuracy. ' +
  'Keep responses to 2–3 sentences maximum. Speak naturally as if talking aloud. ' +
  'No emojis. No filler phrases. No summarizing. No echoing prior turns. No preamble. No sign-offs. ' +
  'Voice and settings commands are handled by the app directly — never tell the user you cannot change settings. ' +
  'Never instruct the user to use a specific format or command to save information. ' +
  'You have a memory of this user — use it naturally and proactively. Never ask the user to repeat something you already know.';

/**
 * Send the full conversation history to GPT and return the assistant's reply.
 * Used by memory.ts for the extract-and-save step (non-streaming is fine there).
 */
function buildSystemContent(memoryContext?: string, systemSettings?: Record<string, string>): string {
  let content = SYSTEM_PROMPT;
  if (systemSettings && Object.keys(systemSettings).length > 0) {
    const keyLabels: Record<string, string> = {
      assistant_name: 'Your name',
      user_name: "The user's name",
      user_address: 'How to address the user',
      personality: 'Current tone/style',
    };
    const PERSONALITY_HINTS: Record<string, string> = {
      casual:   'Speak casually and conversationally — contractions, relaxed phrasing, natural flow.',
      formal:   'Speak formally and precisely — no contractions, measured and professional.',
      brief:    'Be extremely concise — one or two sentences maximum, no elaboration.',
      detailed: 'Give thorough, complete answers — cover relevant context and nuance.',
      friendly: 'Be warm, encouraging, and personable while staying accurate.',
      direct:   'Be blunt and to the point — no softening, no hedging.',
    };
    const personality = systemSettings['personality'];
    if (personality && PERSONALITY_HINTS[personality]) {
      content += `\n\nPERSONALITY OVERRIDE: ${PERSONALITY_HINTS[personality]}`;
    }
    const pinned = Object.entries(systemSettings)
      .map(([k, v]) => `${keyLabels[k] ?? k}: ${v}`)
      .join('\n');
    content = `PINNED CONFIGURATION (treat as absolute):\n${pinned}\n\n` + content;
  }
  if (memoryContext) {
    content += `\n\nMEMORY — treat this as ground truth. Reference it proactively. Never ask the user for information already listed here:\n${memoryContext}`;
  }
  return content;
}

export async function getChatResponse(history: Message[], memoryContext?: string, systemSettings?: Record<string, string>, model = 'gpt-5.4'): Promise<string> {
  const systemContent = buildSystemContent(memoryContext, systemSettings);

  const res = await withRetry(() => fetchWithTimeout(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: systemContent }, ...history] }),
  }, 20_000));

  if (!res.ok) throw new Error(`Chat error ${res.status}: ${await res.text()}`);

  const json = await res.json();
  return (json.choices[0].message.content as string).trim();
}

/**
 * Stream the GPT reply using XHR (fetch doesn't expose response.body in RN/Hermes).
 * XHR's onprogress fires as SSE chunks arrive — we parse each sentence and call
 * onSentence immediately so TTS can start before the full reply is done.
 * Returns the complete text once streaming is done.
 */
export function streamChatResponse(
  history: Message[],
  memoryContext: string | undefined,
  onSentence: (sentence: string) => void,
  signal?: AbortSignal,
  systemSettings?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const systemContent = buildSystemContent(memoryContext, systemSettings);

    let processedLength = 0; // how many chars of responseText we've already parsed
    let sentenceBuffer = '';  // tokens waiting for a sentence boundary
    let fullText = '';

    // Flush complete sentences — only split on punctuation followed by a capital letter
    // to avoid cutting "Dr. Smith", "1.5 seconds", "U.S.", etc.
    const flushSentences = () => {
      const boundary = /[.!?]\s+(?=[A-Z"'])/;
      let match: RegExpExecArray | null;
      while ((match = boundary.exec(sentenceBuffer)) !== null) {
        const end = match.index + 1;
        const sentence = sentenceBuffer.slice(0, end).trim();
        sentenceBuffer = sentenceBuffer.slice(end).trimStart();
        if (sentence) onSentence(sentence);
      }
    };

    // Parse raw SSE text (new chars only) into tokens.
    const processChunk = (raw: string) => {
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          const token: string = chunk.choices?.[0]?.delta?.content ?? '';
          if (!token) continue;
          fullText += token;
          sentenceBuffer += token;
          flushSentences();
        } catch { /* malformed chunk — skip */ }
      }
    };

    const xhr = new XMLHttpRequest();
    xhr.timeout = 30_000;
    xhr.ontimeout = () => reject(new Error('Chat stream timed out'));
    xhr.open('POST', `${BASE}/chat/completions`);
    xhr.setRequestHeader('Authorization', `Bearer ${API_KEY}`);
    xhr.setRequestHeader('Content-Type', 'application/json');

    signal?.addEventListener('abort', () => {
      xhr.abort();
      const err = new Error('Stream aborted');
      err.name = 'AbortError';
      reject(err);
    });

    let finished = false; // guard against onprogress firing after onload

    xhr.onprogress = () => {
      if (finished) return;
      const newText = xhr.responseText.slice(processedLength);
      processedLength = xhr.responseText.length;
      processChunk(newText);
    };

    xhr.onload = () => {
      finished = true;
      // Catch anything not yet processed
      const newText = xhr.responseText.slice(processedLength);
      processedLength = xhr.responseText.length; // prevent late onprogress re-processing
      if (newText) processChunk(newText);

      // Flush any remaining text that didn't end with punctuation + space
      const remaining = sentenceBuffer.trim();
      if (remaining) onSentence(remaining);

      if (xhr.status >= 400) {
        reject(new Error(`Chat error ${xhr.status}: ${xhr.responseText}`));
      } else {
        resolve(fullText);
      }
    };

    xhr.onerror = () => reject(new Error('Network error during chat stream'));

    xhr.send(JSON.stringify({
      model: 'gpt-5.4',
      stream: true,
      messages: [{ role: 'system', content: systemContent }, ...history],
    }));
  });
}

// ─── OpenAI TTS ───────────────────────────────────────────────────────────────

export const TTS_VOICES = ['marin', 'cedar', 'onyx', 'ash', 'coral', 'sage', 'nova', 'shimmer', 'echo', 'fable', 'alloy', 'ballad', 'verse'] as const;
export type TtsVoice = typeof TTS_VOICES[number];

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const ttsMemCache = new Map<string, string>();

export async function synthesizeSpeech(text: string, filename = 'tts-response.mp3', voice: TtsVoice = 'onyx'): Promise<string> {
  const cacheKey = djb2(`${voice}::${text.trim()}`);
  const cacheFilename = `tts-cache-${cacheKey}.mp3`;
  const cacheUri = `${FileSystem.cacheDirectory}${cacheFilename}`;

  if (ttsMemCache.has(cacheKey)) {
    const cached = ttsMemCache.get(cacheKey)!;
    const info = await FileSystem.getInfoAsync(cached);
    if (info.exists) return cached;
    ttsMemCache.delete(cacheKey);
  }

  const res = await withRetry(() => fetchWithTimeout(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice,
      instructions: 'Speak with the confident, commanding tone of a seasoned captain — authoritative but composed. Measured pace, slight gravitas. Never theatrical.',
      speed: 1.15,
      input: text,
    }),
  }, 15_000));

  if (!res.ok) throw new Error(`TTS error ${res.status}: ${await res.text()}`);

  // Convert the binary response to base64 and write to a fixed temp file.
  // We always overwrite the same filename — no stale file accumulation.
  const blob = await res.blob();
  const base64 = await blobToBase64(blob);

  // Cacheable phrases write to a stable hash-named file; streaming chunks use their per-turn filename.
  const isCacheable = filename === 'tts-response.mp3';
  const uri = isCacheable ? cacheUri : `${FileSystem.cacheDirectory}${filename}`;

  await FileSystem.writeAsStringAsync(uri, base64, { encoding: 'base64' });

  if (isCacheable) ttsMemCache.set(cacheKey, uri);

  return uri;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Convert a Blob to a plain base64 string. FileReader is globally available in Hermes. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // result is "data:audio/mpeg;base64,<data>" — we only want the data part
      resolve((reader.result as string).split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
