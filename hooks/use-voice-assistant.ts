/**
 * hooks/use-voice-assistant.ts
 *
 * Orchestrates the full voice loop:
 *   tap → record → (silence auto-stops) → Whisper → GPT → TTS → speak → idle
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { useVoiceRecorder } from './use-voice-recorder';
import { transcribeAudio, getChatResponse, streamChatResponse, synthesizeSpeech, TTS_VOICES, type TtsVoice, type Message } from '@/services/openai';
import { fetchMemories, fetchSystemSettings, saveSystemSetting, extractAndSaveMemory, saveEntry } from '@/services/memory';
import { fetchCalendarContext } from '@/services/google-calendar';

// ─── Whisper hallucination blocklist ─────────────────────────────────────────

const HALLUCINATIONS = new Set([
  'thanks for watching',
  'thank you for watching',
  'thanks a lot for watching',
  'thank you so much for watching',
  'please subscribe',
  'like and subscribe',
  'subscribe',
  'thank you',
  'thanks',
  'you',
  'the',
  'okay',
  'ok',
  'yeah',
  'yes',
  'no',
  'hmm',
  'um',
  'uh',
  'bye',
  'goodbye',
  'see you',
  'see you later',
  'have a good day',
  'have a great day',
  'take care',
]);

const HALLUCINATION_SUBSTRINGS = [
  'if you have any questions or comments, please post them in the comments',
  'casual message to an ai voice assistant',
  'casual spoken message to an ai voice assistant',
  'this is a test',
  'testing testing',
  'brought to you by',
  'don\'t forget to subscribe',
  'smash the like button',
  'in this video',
  'in today\'s video',
  'welcome back to',
  'for watching this video',
];

function isHallucination(text: string): boolean {
  const normalized = text.toLowerCase().trim().replace(/[.!?,]+$/, '');
  if (HALLUCINATIONS.has(normalized)) return true;
  if (HALLUCINATION_SUBSTRINGS.some(s => normalized.includes(s))) return true;

  // Reject if >40% of words are repeated — Whisper looping artifact
  const words = normalized.split(/\s+/);
  if (words.length >= 6) {
    const unique = new Set(words).size;
    if (unique / words.length < 0.5) return true;
  }

  return false;
}

// ─── Silence detection config ─────────────────────────────────────────────────

const SILENCE_DURATION_MS = 900;
const SPEECH_CONFIRM_SAMPLES = 6;  // 600ms of sustained sound before arming
const MIN_SPEECH_DURATION_MS = 500; // must speak for at least 0.5s total
const SPEECH_MARGIN_DB = 10;        // dB above ambient floor to count as speech
const AMBIENT_ALPHA = 0.05;         // EMA smoothing: lower = slower adaptation

// ─── Types ────────────────────────────────────────────────────────────────────

export type TranscriptEntry = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  imageUri?: string;
};

export type AssistantStatus = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVoiceAssistant() {
  const [status, setStatus] = useState<AssistantStatus>('idle');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<{ uri: string; base64: string } | null>(null);

  const history = useRef<Message[]>([]);
  const historySummary = useRef<string>('');
  const hasSpoken = useRef(false);
  const speechSamples = useRef(0);
  const speechStart = useRef<number | null>(null);
  const silenceStart = useRef<number | null>(null);
  const ambientDb = useRef<number>(-42);
  const isProcessing = useRef(false);
  const streamAbort = useRef<AbortController | null>(null);
  const processingGen = useRef(0);
  const turnsSinceCompress = useRef(0);
  const isLooping = useRef(false);
  const [looping, setLooping] = useState(false);
  const mounted = useRef(true);
  const voiceIndex = useRef(TTS_VOICES.indexOf('cedar'));
  const currentVoice = (): TtsVoice => TTS_VOICES[voiceIndex.current];
  const volumeLevel = useRef(1.0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const { startRecording, stopRecording, isRecording, metering } = useVoiceRecorder();

  // Auto-start listening after startup sound finishes
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!mounted.current) return;
      isLooping.current = true;
      setLooping(true);
      const started = await startRecording();
      if (mounted.current) setStatus(started ? 'listening' : 'idle');
      if (!started) { isLooping.current = false; setLooping(false); }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  const MAX_TRANSCRIPT = 50;

  function addTurn(role: 'user' | 'assistant', text: string, imageUri?: string) {
    setTranscript(prev => {
      const next = [...prev, { id: `${Date.now()}-${role}`, role, text, imageUri }];
      return next.length > MAX_TRANSCRIPT ? next.slice(-MAX_TRANSCRIPT) : next;
    });
    history.current.push({ role, content: text });
  }

  const currentSound = useRef<any>(null);

  async function playSound(uri: string): Promise<void> {
    const player = createAudioPlayer({ uri });
    player.volume = volumeLevel.current;
    currentSound.current = player;
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        sub.remove();
        currentSound.current = null;
        try { player.remove(); } catch {}
        resolve();
      };
      const timeout = setTimeout(finish, 30_000);
      const sub = player.addListener('playbackStatusUpdate', (status: any) => {
        if (status.didJustFinish) finish();
      });
      player.play();
    });
  }

  async function resumeLoop() {
    if (!isLooping.current || !mounted.current) return;
    let started = await startRecording();
    if (!started) {
      await new Promise<void>(r => setTimeout(r, 500));
      started = await startRecording();
    }
    if (mounted.current) setStatus(started ? 'listening' : 'idle');
  }

  function interrupt() {
    processingGen.current += 1;
    isProcessing.current = false;
    streamAbort.current?.abort();
    if (currentSound.current) {
      try { currentSound.current.pause(); } catch {}
      try { currentSound.current.remove(); } catch {}
      currentSound.current = null;
    }
    isProcessing.current = false;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function releasePlaybackAudio() {
    await setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: false,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    });
  }

  async function speakAndFinish(reply: string, voice?: TtsVoice) {
    if (mounted.current) addTurn('assistant', reply);
    if (mounted.current) setStatus('speaking');
    const uri = await synthesizeSpeech(reply, 'tts-response.mp3', voice ?? currentVoice());
    await playSound(uri);
    await releasePlaybackAudio();
    const delay = Math.min(800, 300 + reply.split(/\s+/).length * 20);
    await new Promise<void>(r => setTimeout(r, delay));
    if (isLooping.current) { await resumeLoop(); } else { if (mounted.current) setStatus('idle'); }
    isProcessing.current = false;
  }

  function parseSaveCommand(text: string): [string, string] | null {
    let m;
    // Notes
    if ((m = text.match(/^(?:save|add|log|jot(?:\s+down)?|write(?:\s+down)?|make)\s+(?:a\s+)?note[:\-,]?\s*(.+)/i))) return ['note', m[1]];
    if ((m = text.match(/^(?:note|note\s+that)[:\-,]?\s*(.+)/i)))                    return ['note',     m[1]];
    if ((m = text.match(/^remember\s+(?:that\s+)?(.+)/i)))                           return ['note',     m[1]];
    // Tasks / todos
    if ((m = text.match(/^(?:save|add|create|log)\s+(?:a\s+)?(?:task|todo|to-do)[:\-,]?\s*(.+)/i)))  return ['todo', m[1]];
    if ((m = text.match(/^(?:remind me to|don't forget(?:\s+to)?|I need to|add to my list)[:\-,]?\s*(.+)/i))) return ['todo', m[1]];
    // Decisions
    if ((m = text.match(/^(?:save|add|log)\s+(?:a\s+)?decision[:\-,]?\s*(.+)/i)))   return ['decision', m[1]];
    if ((m = text.match(/^(?:we(?:'ve)?\s+decided|I(?:'ve)?\s+decided|decision)[:\-,]?\s*(.+)/i))) return ['decision', m[1]];
    // Summaries
    if ((m = text.match(/^(?:save|add|log)\s+(?:a\s+)?summary[:\-,]?\s*(.+)/i)))    return ['summary',  m[1]];
    return null;
  }

  function buildHistorySlice(imageSnap: { uri: string; base64: string } | null, userText: string): Message[] {
    const recent = history.current.slice(-12).map((msg, i, arr) => {
      if (imageSnap && i === arr.length - 1 && msg.role === 'user') {
        return {
          ...msg,
          content: [
            { type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${imageSnap.base64}`, detail: 'auto' as const } },
            { type: 'text' as const, text: userText },
          ],
        };
      }
      return msg;
    });
    if (!historySummary.current) return recent;
    return [
      { role: 'system' as const, content: `Earlier in this session:\n${historySummary.current}` },
      ...recent,
    ];
  }

  function compressHistory() {
    const KEEP = 12;
    if (history.current.length <= KEEP + 4) return;
    const toSummarize = history.current.slice(0, history.current.length - KEEP);
    history.current = history.current.slice(-KEEP);
    const lines = toSummarize.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : '[image message]'}`).join('\n');
    getChatResponse(
      [{ role: 'user', content: `Summarize this conversation in 3–5 concise sentences, capturing key facts, decisions, and context that would help continue the conversation:\n\n${lines}` }],
      undefined, undefined,
    ).then(summary => {
      historySummary.current = historySummary.current
        ? `${historySummary.current} ${summary}`
        : summary;
    }).catch(() => {});
  }

  // ── Pipeline ───────────────────────────────────────────────────────────────

  const processRecording = useCallback(async () => {
    if (isProcessing.current) return;
    isProcessing.current = true;
    const myGen = ++processingGen.current;
    const stale = () => processingGen.current !== myGen;

    const audioUri = await stopRecording();
    if (!audioUri) {
      isProcessing.current = false;
      if (isLooping.current) { await resumeLoop(); } else { if (mounted.current) setStatus('error'); }
      return;
    }

    await setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    });

    setStatus('processing');

    try {
      const [userText, memoryContext, systemSettings, calendarContext] = await Promise.all([
        transcribeAudio(audioUri),
        fetchMemories(),
        fetchSystemSettings(),
        fetchCalendarContext(),
      ]);

      if (stale()) return;

      // Strip wake word prefix — Whisper may transcribe "Hey R3" several ways
      const cleaned = userText.replace(/^(?:hey\s+(?:r(?:3(?:-?d(?:2)?)?|three)|are\s+three(?:\s+d(?:ew|2)?)?),?\s*)/i, '').trim();
      const finalText = cleaned || userText;

      if (finalText.trim().split(/\s+/).length < 4 || isHallucination(finalText)) {
        isProcessing.current = false;
        if (isLooping.current) { await resumeLoop(); } else { if (mounted.current) setStatus('idle'); }
        return;
      }

      const imageSnap = pendingImage;
      if (imageSnap) setPendingImage(null);
      addTurn('user', finalText, imageSnap?.uri);

      // ── System settings ───────────────────────────────────────────────────
      const nameMatch = finalText.match(/(?:your name is|call yourself|you are called)\s+(\w+)/i);
      if (nameMatch) {
        await saveSystemSetting('assistant_name', nameMatch[1]);
        return speakAndFinish(`Acknowledged. I'll go by ${nameMatch[1]} from now on.`);
      }

      const addressMatch = finalText.match(/(?:address|refer to|call)\s+me\s+as\s+(.+)/i);
      if (addressMatch) {
        const title = addressMatch[1].trim().replace(/[.!]+$/, '');
        await saveSystemSetting('user_address', title);
        return speakAndFinish(`Understood. I'll address you as ${title}.`);
      }

      const userNameMatch = finalText.match(/(?:my name is|call me)\s+([A-Z][a-z]+)/);
      if (userNameMatch) {
        await saveSystemSetting('user_name', userNameMatch[1]);
        return speakAndFinish(`Got it, ${userNameMatch[1]}. I'll remember that.`);
      }

      // ── Voice selection ────────────────────────────────────────────────────
      const lowerText = finalText.toLowerCase();
      const mentionedVoice = TTS_VOICES.find(v => lowerText.includes(v));
      const isVoiceCmd = mentionedVoice && /voice|sound|speak|switch|change|use|set/i.test(finalText);
      if (isVoiceCmd) {
        const idx = TTS_VOICES.indexOf(mentionedVoice);
        voiceIndex.current = idx;
        return speakAndFinish(`Switched to ${mentionedVoice}.`, mentionedVoice);
      }

      // ── Volume control ────────────────────────────────────────────────────
      const volUpMatch = /\b(?:louder|volume up|speak up|turn(?:ing)? up|increase volume|more volume)\b/i.test(finalText);
      const volDownMatch = /\b(?:quieter|softer|volume down|turn(?:ing)? (?:it )?down|lower(?: the)? volume|decrease volume|less volume)\b/i.test(finalText);
      const volSetMatch = finalText.match(/\bvolume\s+(?:to\s+)?(\d+)\b/i);
      if (volUpMatch || volDownMatch || volSetMatch) {
        if (volSetMatch) {
          volumeLevel.current = Math.min(1, Math.max(0.1, parseInt(volSetMatch[1]) / 10));
        } else if (volUpMatch) {
          volumeLevel.current = Math.min(1.0, volumeLevel.current + 0.2);
        } else {
          volumeLevel.current = Math.max(0.1, volumeLevel.current - 0.2);
        }
        const pct = Math.round(volumeLevel.current * 10);
        return speakAndFinish(`Volume set to ${pct}.`);
      }

      // ── Personality tuning ────────────────────────────────────────────────
      const personalityMatch = finalText.match(/\bbe\s+(?:more\s+)?(\w+)/i);
      const PERSONALITIES: Record<string, string> = {
        casual: 'casual', informal: 'casual', relaxed: 'casual', chill: 'casual',
        formal: 'formal', professional: 'formal', serious: 'formal',
        brief: 'brief', concise: 'brief', short: 'brief', quick: 'brief',
        detailed: 'detailed', verbose: 'detailed', thorough: 'detailed',
        friendly: 'friendly', warm: 'friendly', kind: 'friendly',
        direct: 'direct', blunt: 'direct', sharp: 'direct',
      };
      if (personalityMatch) {
        const trait = PERSONALITIES[personalityMatch[1].toLowerCase()];
        if (trait) {
          await saveSystemSetting('personality', trait);
          return speakAndFinish(`Adjusted. Switching to ${trait} mode.`);
        }
      }

      // ── Voice-commanded saves ─────────────────────────────────────────────
      const saveMatch = parseSaveCommand(finalText);
      if (saveMatch) {
        try { await saveEntry(saveMatch[0], saveMatch[1].trim()); }
        catch { if (mounted.current) { setError('Something went off course. Check your connection.'); setStatus('error'); } isProcessing.current = false; return; }
        const replies: Record<string, string> = {
          note: 'Acknowledged. Logged and secured.',
          todo: 'Task received. Adding it to the manifest.',
          decision: 'Decision locked in. We\'ll proceed accordingly.',
          summary: 'Summary received. Stored and ready for deployment.',
        };
        return speakAndFinish(replies[saveMatch[0]] ?? 'Handled.');
      }

      // ── Normal GPT flow ───────────────────────────────────────────────────
      streamAbort.current?.abort();
      streamAbort.current = new AbortController();

      const ttsQueue: Promise<string>[] = [];
      let streamDone = false;

      // Fire streaming without awaiting — play loop runs concurrently
      const fullContext = [memoryContext, calendarContext].filter(Boolean).join('\n\n');
      const streamPromise = streamChatResponse(
        buildHistorySlice(imageSnap, finalText),
        fullContext,
        (sentence) => {
          const words = sentence.trim().split(/\s+/);
          const alphaRatio = (sentence.match(/[a-zA-Z]/g)?.length ?? 0) / sentence.length;
          if (words.length < 1 || alphaRatio < 0.4) return;
          ttsQueue.push(synthesizeSpeech(sentence, `tts-${myGen}-${ttsQueue.length}.mp3`, currentVoice()));
        },
        streamAbort.current.signal,
        systemSettings,
      ).then(text => { streamDone = true; return text; })
        .catch(err => { streamDone = true; throw err; });

      if (mounted.current) setStatus('speaking');

      // Drain the TTS queue as sentences arrive, without waiting for streaming to finish
      let playIdx = 0;
      while (true) {
        if (stale()) { isProcessing.current = false; return; }
        if (playIdx < ttsQueue.length) {
          const uri = await ttsQueue[playIdx];
          if (stale()) { isProcessing.current = false; return; }
          await playSound(uri);
          playIdx++;
        } else if (streamDone) {
          break;
        } else {
          await new Promise<void>(r => setTimeout(r, 50));
        }
      }

      await releasePlaybackAudio();

      if (stale()) { isProcessing.current = false; return; }
      const assistantText = await streamPromise; // already resolved

      history.current.push({ role: 'assistant', content: assistantText });
      if (mounted.current) setTranscript(prev => [...prev, { id: `${Date.now()}-assistant`, role: 'assistant', text: assistantText }]);

      if (stale()) return;
      extractAndSaveMemory(finalText, assistantText);
      turnsSinceCompress.current += 1;
      if (turnsSinceCompress.current >= 10) { turnsSinceCompress.current = 0; compressHistory(); }
      await new Promise<void>(r => setTimeout(r, 800));
      if (isLooping.current) { await resumeLoop(); } else { if (mounted.current) setStatus('idle'); }
      isProcessing.current = false;

    } catch (err: any) {
      if (err?.name === 'AbortError') { isProcessing.current = false; return; }
      console.error('[useVoiceAssistant]', err);
      isProcessing.current = false;
      if (!mounted.current) return;

      const msg = (err?.message ?? '').toLowerCase();
      const recoveryLine =
        msg.includes('network') || msg.includes('fetch')
          ? 'Lost the signal. Check your connection.'
          : msg.includes('timeout')
          ? 'That took too long. Say it again.'
          : msg.includes('whisper') || msg.includes('transcri')
          ? 'Missed that. Say it again.'
          : 'Something went sideways. Standing by.';

      try {
        await speakAndFinish(recoveryLine);
      } catch {
        setError(recoveryLine);
        setStatus('error');
      }
    }
  }, [stopRecording, startRecording]);

  // ── Silence detection ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!isRecording || metering === undefined || status !== 'listening') return;

    const threshold = ambientDb.current + SPEECH_MARGIN_DB;

    if (metering > threshold) {
      speechSamples.current += 1;
      if (speechSamples.current >= SPEECH_CONFIRM_SAMPLES && !hasSpoken.current) {
        hasSpoken.current = true;
        speechStart.current = Date.now();
      }
      silenceStart.current = null;
    } else {
      // Update ambient floor only while not actively speaking
      if (!hasSpoken.current) {
        ambientDb.current = ambientDb.current * (1 - AMBIENT_ALPHA) + metering * AMBIENT_ALPHA;
      }

      if (hasSpoken.current) {
        speechSamples.current = 0;
        if (silenceStart.current === null) {
          silenceStart.current = Date.now();
        } else if (Date.now() - silenceStart.current >= SILENCE_DURATION_MS) {
          const spokenDuration = speechStart.current ? Date.now() - speechStart.current : 0;
          hasSpoken.current = false;
          speechStart.current = null;
          silenceStart.current = null;
          if (spokenDuration >= MIN_SPEECH_DURATION_MS) processRecording();
        }
      }
    }
  }, [metering, isRecording, status, processRecording]);

  useEffect(() => {
    if (!isRecording) {
      hasSpoken.current = false;
      speechSamples.current = 0;
      speechStart.current = null;
      silenceStart.current = null;
    }
  }, [isRecording]);

  // ── Button handler ─────────────────────────────────────────────────────────

  const handlePress = useCallback(async () => {
    if (status === 'speaking' || status === 'processing') {
      // Interrupt mid-response and jump straight back to listening
      interrupt();
      if (isLooping.current) {
        await resumeLoop();
      } else {
        if (mounted.current) setStatus('idle');
      }
    } else if (looping) {
      // Stop the loop entirely
      isLooping.current = false;
      setLooping(false);
      interrupt();
      setError(null);
      setStatus('idle');
    } else if (status === 'idle' || status === 'error') {
      // Start the loop
      isLooping.current = true;
      setLooping(true);
      setError(null);
      const started = await startRecording();
      if (started) {
        setStatus('listening');
      } else {
        isLooping.current = false;
        setLooping(false);
        setError('Microphone access denied. Enable it in Android Settings → Apps → R3-D2 → Permissions.');
        setStatus('error');
      }
    }
  }, [status, looping, startRecording]);

  return { status, transcript, error, looping, handlePress, pendingImage, setPendingImage };
}
