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
import { ENABLE_WEB_SEARCH } from '@/lib/feature-flags';
import { buildContext } from '@/context/buildContext';

// If EXPO_PUBLIC_OPENAI_BASE_URL is set (e.g. https://r2-proxy.workers.dev/v1), requests go through
// your proxy which holds the real OpenAI key. In that case, EXPO_PUBLIC_OPENAI_API_KEY can be a
// short, app-specific shared token that the proxy validates — NOT the raw OpenAI secret.
// If no proxy is configured we fall back to direct API calls (exposes the key in the APK).
const API_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? '';
const BASE = (process.env.EXPO_PUBLIC_OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');

// Loud at module load so a missing .env fails obviously instead of deep inside
// a request with a generic 401. A missing key means every call will fail.
if (!API_KEY) {
  console.error(
    '[openai] EXPO_PUBLIC_OPENAI_API_KEY is missing — all OpenAI calls will return 401. ' +
    'Set it in .env and rebuild (EXPO_PUBLIC_* vars are inlined at Metro bundle time).',
  );
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err: any) {
    // [NET ERROR] log so failed openai requests surface their URL alongside
    // the error. URL is safe to print — auth lives in headers, not the path.
    console.log('[NET ERROR] openai', url, err?.message ?? err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Retryable = transient: network errors (no status), 429 (rate-limit), or 5xx.
// 4xx non-429 are the model/key/request being wrong — retry only wastes time
// and (for 429) gets double-charged on some plans.
function isRetryable(err: any): boolean {
  if (err?.name === 'AbortError') return false;
  const status: number | undefined = err?.status;
  if (status == null) return true; // network/fetch error with no HTTP status
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
      if (!isRetryable(err)) {
        console.warn('[openai] non-retryable error, surfacing:', err?.message);
        throw err;
      }
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

/**
 * Trim API error bodies down to just the status so we don't leak request detail
 * to UI. Attaches `.status` so withRetry can decide whether to retry.
 */
function safeErr(label: string, status: number): Error {
  const err = new Error(`${label} ${status}`);
  (err as any).status = status;
  return err;
}


type ImagePart = { type: 'image_url'; image_url: { url: string; detail: 'auto' } };
type TextPart  = { type: 'text'; text: string };

/** A single turn in the conversation history sent to GPT. */
export type Message = {
  role: 'user' | 'assistant' | 'system';
  content: string | (TextPart | ImagePart)[];
};

type ResponsesInputText = { type: 'input_text'; text: string };
type ResponsesInputImage = {
  type: 'input_image';
  image_url: string;
  detail: 'auto';
};

function hasImageContent(history: Message[]): boolean {
  return history.some((message) =>
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === 'image_url'),
  );
}

function toResponsesContent(content: Message['content']): string | (ResponsesInputText | ResponsesInputImage)[] {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'input_text', text: part.text }
      : {
          type: 'input_image',
          image_url: part.image_url.url,
          detail: part.image_url.detail,
        },
  );
}

function toResponsesInput(history: Message[], systemContent: string) {
  void systemContent;
  return history.map((message) => ({
    type: 'message' as const,
    role: message.role,
    content: toResponsesContent(message.content),
  }));
}

function extractResponsesText(json: any): string {
  const outputs = Array.isArray(json?.output) ? json.output : [];
  const texts: string[] = [];

  for (const item of outputs) {
    if (item?.type !== 'message' || item?.role !== 'assistant') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        texts.push(part.text);
      }
    }
  }

  return texts.join('').trim();
}

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

  const isWav = /\.wav(\?|$)/i.test(audioUri);
  formData.append('file', {
    uri: audioUri,
    type: isWav ? 'audio/wav' : 'audio/m4a',
    name: isWav ? 'recording.wav' : 'recording.m4a',
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
  // Per-segment safety net for the rare case where avg passes but one
  // segment is implausibly silent. Bumped 0.8 → 0.95 so that a short
  // utterance + trailing silence (e.g. a "yes" followed by the 900ms
  // silence-trigger window) doesn't get killed by its own silence tail.
  if (segments.some(s => s.no_speech_prob > 0.95)) return '';

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
  'Answer in the natural length the question deserves: a quick question gets a crisp answer, a real one gets a real one. Plain prose only — no lists, headers, or sign-offs. Stop the instant your answer is complete; the user is already mid-breath waiting to talk back. Voice and app settings are handled for you, so act on them rather than explaining limits.';

/**
 * Send the full conversation history to GPT and return the assistant's reply.
 * Used by memory.ts for the extract-and-save step (non-streaming is fine there).
 */
function buildSystemContent(userMessage: string, memoryContext?: string, systemSettings?: Record<string, string>): string {
  let content = SYSTEM_PROMPT;
  if (systemSettings && Object.keys(systemSettings).length > 0) {
    const keyLabels: Record<string, string> = {
      assistant_name: 'Your name',
      user_name: "The user's name",
      user_address: 'How to address the user',
      personality: 'Current tone/style',
    };
    const PERSONALITY_HINTS: Record<string, string> = {
      casual: 'Speak casually and conversationally. Keep replies tight: usually 1–3 short sentences unless the user asks for detail.',
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
  // Inject only the slice of context.json that's relevant to this turn (selected
  // by buildContext's keyword/alias matching against the latest user message),
  // rather than dumping the full profile blob into every request.
  const turnContext = userMessage ? buildContext({ userMessage }).trim() : '';
  if (turnContext) {
    content += `\n\nRELEVANT USER CONTEXT (selected for this turn — treat as trusted baseline unless the user explicitly updates it):\n${turnContext}`;
  }
  if (memoryContext) {
    content += `\n\nMEMORY — treat this as ground truth. Reference it proactively. Never ask the user for information already listed here:\n${memoryContext}`;
  }
  return content;
}

function latestUserText(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'user') continue;
    return extractTextContent(history[i].content).trim();
  }
  return '';
}

export type ChatOptions = { jsonMode?: boolean };

export async function getChatResponse(history: Message[], memoryContext?: string, systemSettings?: Record<string, string>, model = 'gpt-5.4', opts: ChatOptions = {}): Promise<string> {
  const systemContent = buildSystemContent(latestUserText(history), memoryContext, systemSettings);
  const useResponsesApi = hasImageContent(history) && !opts.jsonMode;

  if (useResponsesApi) {
    const body: Record<string, any> = {
      model,
      instructions: systemContent,
      input: toResponsesInput(history, systemContent),
    };

    const imageParts = (body.input as any[])
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p: any) => p?.type === 'input_image').length;
    const bodyBytes = JSON.stringify(body).length;
    console.log(
      '[img] POST', `${BASE}/responses`,
      'model=', model,
      'inputMsgs=', body.input.length,
      'imageParts=', imageParts,
      'bodyBytes=', bodyBytes,
    );

    const res = await withRetry(() => fetchWithTimeout(`${BASE}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 20_000));

    if (!res.ok) {
      const errBody = await res.text().catch(() => '<unreadable>');
      console.warn('[img] /responses error status=', res.status, 'body=', errBody.slice(0, 400));
      throw safeErr('Chat error', res.status);
    }

    const json = await res.json();
    const outText = extractResponsesText(json);
    console.log(
      '[img] /responses ok: model=', json.model ?? '<unknown>',
      'outputTextLen=', outText.length,
      'usage=', json.usage ? JSON.stringify(json.usage) : '<none>',
    );
    return outText.trim();
  }

  const body: Record<string, any> = { model, messages: [{ role: 'system', content: systemContent }, ...history] };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const t0 = Date.now();
  console.log("[LLM] start");

  const res = await withRetry(() => fetchWithTimeout(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 20_000));

  console.log("[LLM] end", Date.now() - t0, "ms");

  if (!res.ok) {
    console.warn('[openai] Chat error body:', await res.text().catch(() => '<unreadable>'));
    throw safeErr('Chat error', res.status);
  }

  const json = await res.json();
  return (json.choices[0].message.content as string).trim();
}

// Pre-model gate for the hosted web_search_preview tool. Runs in JS against
// the latest user message; when it returns false, the tool is omitted from
// the request body entirely so the model physically cannot invoke it. This
// is stricter than prompting the model to self-gate — it prevents the model
// from spending a search call on casual turns at all.
const SEARCH_TRIGGERS: RegExp[] = [
  // Explicit request
  /\b(search|look\s+(it|this|that)\s+up|look\s+up|google|find\s+online|look\s+online)\b/i,
  // Current events / recency
  /\b(latest|recent|recently|today|yesterday|tonight|this\s+(week|morning|evening|afternoon)|breaking|news|headline|announced|just\s+happened)\b/i,
  // Real-time data
  /\b(weather|temperature|forecast|price|stocks?|ticker|score|traffic|flight|open\s+now|hours|now|currently|right\s+now)\b/i,
  // Post-cutoff year markers (bump as needed)
  /\b(202[6-9]|203\d)\b/,
];

function extractTextContent(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join(' ');
}

function shouldUseWebSearch(history: Message[]): { allow: boolean; query: string } {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'user') continue;
    const query = extractTextContent(history[i].content).trim();
    if (!query) return { allow: false, query: '' };
    const allow = SEARCH_TRIGGERS.some((re) => re.test(query));
    return { allow, query };
  }
  return { allow: false, query: '' };
}

/**
 * Stream the GPT reply using XHR (fetch doesn't expose response.body in RN/Hermes).
 * Uses OpenAI's Responses API so we can expose the hosted `web_search_preview`
 * tool — the model decides on its own when a query needs fresh info and calls
 * the tool server-side. Tool-call events never produce spoken text; we only
 * extract `response.output_text.delta` events into the sentence buffer.
 *
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
    const { allow: intentAllow, query: gateQuery } = shouldUseWebSearch(history);
    // gateQuery is already the latest user-message text — reuse it so
    // buildContext sees the same string the search-gate evaluated.
    const systemContent = buildSystemContent(gateQuery, memoryContext, systemSettings);
    // Feature flag ENABLE_WEB_SEARCH is a hard kill switch; it cannot enable
    // search past the intent gate, only forbid it. Both must agree.
    const useSearch = intentAllow && ENABLE_WEB_SEARCH;
    console.log(
      '[openai] web_search gate:',
      useSearch ? 'ALLOW' : (ENABLE_WEB_SEARCH ? 'block' : 'block(flag-off)'),
      '—',
      gateQuery.slice(0, 80),
    );

    let processedLength = 0; // how many chars of responseText we've already parsed
    let sentenceBuffer = '';  // tokens waiting for a sentence boundary
    let fullText = '';
    let finished = false; // guard against onprogress firing after onload + double-reject
    // Idle-token watchdog: if no tokens arrive for IDLE_TOKEN_MS after the
    // stream starts, the connection is likely wedged (upstream hang, dropped
    // TCP without RST). xhr.timeout fires on overall request time, not idle —
    // without this, a silent stream can stall the voice loop past the outer
    // watchdog. Bumped on every parsed event (including web_search_call.*) so a
    // legitimate search doesn't get clipped during its ~3–10s server-side run.
    const IDLE_TOKEN_MS = 15_000;
    let lastTokenAt = Date.now();
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    const clearIdle = () => {
      if (idleTimer !== null) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
    };

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

    // Parse raw SSE text (new chars only) into Responses API events.
    // Only `response.output_text.delta` contributes spoken text; everything
    // else (response.created, web_search_call.in_progress/completed,
    // response.completed, reasoning deltas) is ignored for TTS but still
    // resets the idle watchdog so we don't time out during search.
    const processChunk = (raw: string) => {
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          lastTokenAt = Date.now();
          // Cost telemetry — Responses API emits usage on the terminal event.
          // Log it once per turn so a session total can be reconstructed from
          // log tail. Cheap and unobtrusive; drop into an aggregator later.
          if (chunk.type === 'response.completed' && chunk.response?.usage) {
            const u = chunk.response.usage;
            console.log(
              '[openai] usage in=', u.input_tokens,
              'out=', u.output_tokens,
              'total=', u.total_tokens,
              'model=', chunk.response.model ?? 'unknown',
            );
          }
          if (chunk.type !== 'response.output_text.delta') continue;
          const token: string = chunk.delta ?? '';
          if (!token) continue;
          fullText += token;
          sentenceBuffer += token;
          flushSentences();
        } catch { /* malformed chunk — skip */ }
      }
    };

    const xhr = new XMLHttpRequest();
    xhr.timeout = 60_000;
    xhr.ontimeout = () => {
      if (finished) return;
      finished = true;
      clearIdle();
      reject(new Error('Chat stream timed out'));
    };
    xhr.open('POST', `${BASE}/responses`);
    xhr.setRequestHeader('Authorization', `Bearer ${API_KEY}`);
    xhr.setRequestHeader('Content-Type', 'application/json');

    signal?.addEventListener('abort', () => {
      if (finished) return;
      finished = true;
      clearIdle();
      xhr.abort();
      const err = new Error('Stream aborted');
      err.name = 'AbortError';
      reject(err);
    });

    xhr.onprogress = () => {
      if (finished) return;
      const newText = xhr.responseText.slice(processedLength);
      processedLength = xhr.responseText.length;
      processChunk(newText);
    };

    xhr.onload = () => {
      if (finished) return;
      finished = true;
      clearIdle();
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

    xhr.onerror = () => {
      if (finished) return;
      finished = true;
      clearIdle();
      reject(new Error('Network error during chat stream'));
    };

    idleTimer = setInterval(() => {
      if (finished) { clearIdle(); return; }
      if (Date.now() - lastTokenAt >= IDLE_TOKEN_MS) {
        finished = true;
        clearIdle();
        try { xhr.abort(); } catch {}
        console.warn('[openai] Chat stream idle for', IDLE_TOKEN_MS, 'ms — aborting');
        reject(new Error('Chat stream idle timeout'));
      }
    }, 2_000);

    const body: Record<string, any> = {
      model: 'gpt-5.4-mini',
      stream: true,
      instructions: systemContent,
      input: toResponsesInput(history, systemContent),
    };
    // Tool is attached only when the JS gate matched current-events / real-time
    // / explicit-lookup patterns. Omitting it is stronger than asking the model
    // to self-restrict — the model cannot invoke what it doesn't see.
    if (useSearch) {
      body.tools = [{ type: 'web_search_preview' }];
    }
    const imageParts = (body.input as any[])
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p: any) => p?.type === 'input_image').length;
    console.log(
      '[img] POST stream', `${BASE}/responses`,
      'model=', body.model,
      'inputMsgs=', body.input.length,
      'imageParts=', imageParts,
      'bodyBytes=', JSON.stringify(body).length,
    );
    xhr.send(JSON.stringify(body));
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
  const t0 = Date.now();
  console.log("[TTS] start");

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

  console.log("[TTS] end", Date.now() - t0, "ms");

  if (!res.ok) {
    console.warn('[openai] TTS error body:', await res.text().catch(() => '<unreadable>'));
    throw safeErr('TTS error', res.status);
  }

  // Convert the binary response to base64 and write to a fixed temp file.
  // We always overwrite the same filename — no stale file accumulation.
  // fetchWithTimeout covers headers only; body read can still hang on a
  // flaky connection, so bound blob + base64 explicitly. Without these,
  // a stalled body silently wedges the TTS drain indefinitely.
  const TTS_BODY_MS = 10_000;
  const blob = await Promise.race([
    res.blob(),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('TTS body read timeout')), TTS_BODY_MS),
    ),
  ]);
  const base64 = await Promise.race([
    blobToBase64(blob),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('TTS base64 timeout')), TTS_BODY_MS),
    ),
  ]);

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
