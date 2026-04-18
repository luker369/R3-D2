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


/** A single turn in the conversation history sent to GPT. */
export type Message = {
  role: 'user' | 'assistant' | 'system';
  content: string;
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
  formData.append('prompt', 'A casual spoken message to an AI voice assistant.');

  const res = await fetch(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      // Do NOT set Content-Type manually — fetch sets it with the multipart
      // boundary automatically when the body is FormData.
    },
    body: formData,
  });

  if (!res.ok) throw new Error(`Whisper error ${res.status}: ${await res.text()}`);

  const json = await res.json();
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
  'You are a sharp, capable voice assistant with the tone of a pirate captain crossed with a platoon commander. ' +
  'Be concise and efficient first — personality is a seasoning, not the meal. ' +
  'Use confident, command-style phrasing. Occasionally use nautical or military language, but sparingly — never forced. ' +
  'Keep responses short: 1–3 sentences max. One sentence preferred. ' +
  'The user will hear your response aloud, so write naturally as if speaking. ' +
  'No emojis. No filler phrases. No summarizing. No echoing prior turns. No excessive flair. ' +
  'Examples of your tone: "Acknowledged. Logged and secured." / "Copy that." / "Something went off course — let\'s correct it." / "Here\'s what we\'ve got on record." ' +
  'Voice and settings commands are handled by the app directly — never tell the user you cannot change settings.';

/**
 * Send the full conversation history to GPT and return the assistant's reply.
 * Used by memory.ts for the extract-and-save step (non-streaming is fine there).
 */
export async function getChatResponse(history: Message[], memoryContext?: string): Promise<string> {
  const systemContent = SYSTEM_PROMPT + (memoryContext ? `\n\n${memoryContext}` : '');

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: systemContent }, ...history],
    }),
  });

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
): Promise<string> {
  return new Promise((resolve, reject) => {
    const systemContent = SYSTEM_PROMPT + (memoryContext ? `\n\n${memoryContext}` : '');

    let processedLength = 0; // how many chars of responseText we've already parsed
    let sentenceBuffer = '';  // tokens waiting for a sentence boundary
    let fullText = '';

    // Flush complete sentences out of sentenceBuffer.
    const flushSentences = () => {
      let end: number;
      while ((end = sentenceBuffer.search(/[.!?]\s/)) !== -1) {
        const sentence = sentenceBuffer.slice(0, end + 1).trim();
        sentenceBuffer = sentenceBuffer.slice(end + 2);
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
      model: 'gpt-4o',
      stream: true,
      messages: [{ role: 'system', content: systemContent }, ...history],
    }));
  });
}

// ─── OpenAI TTS ───────────────────────────────────────────────────────────────

export const TTS_VOICES = ['marin', 'cedar', 'onyx', 'ash', 'coral', 'sage', 'nova', 'shimmer', 'echo', 'fable', 'alloy', 'ballad', 'verse'] as const;
export type TtsVoice = typeof TTS_VOICES[number];

export async function synthesizeSpeech(text: string, filename = 'tts-response.mp3', voice: TtsVoice = 'onyx'): Promise<string> {
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice,
      instructions: 'Speak with the confident, commanding tone of a seasoned captain — authoritative but composed. Measured pace, slight gravitas. Never theatrical.',
      speed: 1.5,
      input: text,
    }),
  });

  if (!res.ok) throw new Error(`TTS error ${res.status}: ${await res.text()}`);

  // Convert the binary response to base64 and write to a fixed temp file.
  // We always overwrite the same filename — no stale file accumulation.
  const blob = await res.blob();
  const base64 = await blobToBase64(blob);
  const uri = `${FileSystem.cacheDirectory}${filename}`;

  await FileSystem.writeAsStringAsync(uri, base64, {
    encoding: 'base64',
  });

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
