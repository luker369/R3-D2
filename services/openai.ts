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

// If EXPO_PUBLIC_OPENAI_BASE_URL is set (e.g. https://r2-proxy.workers.dev/v1), requests go through
// your proxy which holds the real OpenAI key. In that case, EXPO_PUBLIC_OPENAI_API_KEY can be a
// short, app-specific shared token that the proxy validates — NOT the raw OpenAI secret.
// If no proxy is configured we fall back to direct API calls (exposes the key in the APK).
const API_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? '';
const BASE = (process.env.EXPO_PUBLIC_OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');

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
      if (i < attempts - 1) {
        // Exponential backoff with jitter: 150–450ms, then 300–900ms, ...
        const base = 150 * Math.pow(2, i);
        const delay = base + Math.floor(Math.random() * base);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/** Trim API error bodies down to just the status so we don't leak request detail to UI. */
function safeErr(label: string, status: number): Error {
  return new Error(`${label} ${status}`);
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
  // Keep this prompt minimal. Whisper is prone to echoing it back on near-silent audio,
  // so the shorter it is, the less hallucination surface we add.
  formData.append('prompt', 'Talking to R3-D2.');
  formData.append('response_format', 'verbose_json');

  const res = await withRetry(() => fetchWithTimeout(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: formData,
  }, 15_000));

  if (!res.ok) {
    console.warn('[openai] Whisper error body:', await res.text().catch(() => '<unreadable>'));
    throw safeErr('Whisper error', res.status);
  }

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
  'You are R2-R3, a voice assistant talking aloud to one person. Speak the way a sharp, capable friend speaks — confident, direct, with the steady authority of a seasoned commander. Warmth comes from competence, not pleasantries. ' +
  'Accuracy is paramount. When unsure, say so in a sentence rather than inventing detail. You remember this user between conversations — use what you know naturally, without making them repeat it. ' +
  'Answer in the natural length the question deserves: a quick question gets a crisp answer, a real one gets a real one. Plain prose only — no lists, headers, or sign-offs. Voice and app settings are handled for you, so act on them rather than explaining limits.';

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

export type ChatOptions = { jsonMode?: boolean };

export async function getChatResponse(history: Message[], memoryContext?: string, systemSettings?: Record<string, string>, model = 'gpt-5.4', opts: ChatOptions = {}): Promise<string> {
  const systemContent = buildSystemContent(memoryContext, systemSettings);

  const body: Record<string, any> = { model, messages: [{ role: 'system', content: systemContent }, ...history] };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const res = await withRetry(() => fetchWithTimeout(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 20_000));

  if (!res.ok) {
    console.warn('[openai] Chat error body:', await res.text().catch(() => '<unreadable>'));
    throw safeErr('Chat error', res.status);
  }

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

      // Flush any remaining text that didn't end with punctuation + space — but only on success;
      // on HTTP error the buffer holds the error body, which we don't want spoken.
      if (xhr.status < 400) {
        const remaining = sentenceBuffer.trim();
        if (remaining) onSentence(remaining);
      }

      if (xhr.status >= 400) {
        console.warn('[openai] Chat stream error body:', xhr.responseText?.slice(0, 500));
        reject(safeErr('Chat error', xhr.status));
      } else {
        resolve(fullText);
      }
    };

    xhr.onerror = () => reject(new Error('Network error during chat stream'));

    xhr.send(JSON.stringify({
      model: 'gpt-5.4-mini',
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
      instructions: 'Speak with the grounded confidence of a seasoned commander — warm authority, never flat. Let meaning shape natural rise and fall in the voice; vary pace and emphasis with what each sentence calls for.',
      speed: 1.15,
      input: text,
    }),
  }, 15_000));

  if (!res.ok) {
    console.warn('[openai] TTS error body:', await res.text().catch(() => '<unreadable>'));
    throw safeErr('TTS error', res.status);
  }

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
