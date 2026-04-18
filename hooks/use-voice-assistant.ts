/**
 * hooks/use-voice-assistant.ts
 *
 * Orchestrates the full voice loop:
 *   tap → record → (silence auto-stops) → Whisper → GPT → TTS → speak → idle
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Audio } from 'expo-av';
import { useVoiceRecorder } from './use-voice-recorder';
import { transcribeAudio, streamChatResponse, synthesizeSpeech, TTS_VOICES, type TtsVoice, type Message } from '@/services/openai';
import { fetchMemories, extractAndSaveMemory, saveEntry } from '@/services/memory';

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
]);

function isHallucination(text: string): boolean {
  return HALLUCINATIONS.has(text.toLowerCase().trim().replace(/[.!?,]+$/, ''));
}

// ─── Silence detection config ─────────────────────────────────────────────────

const SPEECH_THRESHOLD_DB = -22;
const SILENCE_DURATION_MS = 1200;
const SPEECH_CONFIRM_SAMPLES = 6;  // 600ms of sustained sound before arming
const MIN_SPEECH_DURATION_MS = 500; // must speak for at least 0.5s total

// ─── Types ────────────────────────────────────────────────────────────────────

export type TranscriptEntry = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

export type AssistantStatus = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVoiceAssistant() {
  const [status, setStatus] = useState<AssistantStatus>('idle');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const history = useRef<Message[]>([]);
  const hasSpoken = useRef(false);
  const speechSamples = useRef(0);
  const speechStart = useRef<number | null>(null);
  const silenceStart = useRef<number | null>(null);
  const isProcessing = useRef(false);
  const streamAbort = useRef<AbortController | null>(null);
  const processingGen = useRef(0);
  const mounted = useRef(true);
  const voiceIndex = useRef(TTS_VOICES.indexOf('cedar'));
  const currentVoice = (): TtsVoice => TTS_VOICES[voiceIndex.current];

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const { startRecording, stopRecording, isRecording, metering } = useVoiceRecorder();

  const MAX_TRANSCRIPT = 50;

  function addTurn(role: 'user' | 'assistant', text: string) {
    setTranscript(prev => {
      const next = [...prev, { id: `${Date.now()}-${role}`, role, text }];
      return next.length > MAX_TRANSCRIPT ? next.slice(-MAX_TRANSCRIPT) : next;
    });
    history.current.push({ role, content: text });
  }

  // Play a single audio URI and resolve when done.
  // expo-av's didJustFinish is reliable; setAudioModeAsync resets Android session.
  const currentSound = useRef<any>(null);

  async function playSound(uri: string): Promise<void> {
    const { sound } = await Audio.Sound.createAsync({ uri });
    currentSound.current = sound;
    return new Promise((resolve) => {
      const finish = () => { currentSound.current = null; sound.unloadAsync(); resolve(); };
      const timeout = setTimeout(finish, 30_000);
      sound.setOnPlaybackStatusUpdate((s: any) => {
        if (s.didJustFinish || (!s.isLoaded && s.error)) {
          clearTimeout(timeout);
          finish();
        }
      });
      sound.playAsync().catch(() => { clearTimeout(timeout); finish(); });
    });
  }

  function interrupt() {
    processingGen.current += 1;
    streamAbort.current?.abort();
    if (currentSound.current) {
      currentSound.current.stopAsync().catch(() => {});
      currentSound.current.unloadAsync().catch(() => {});
      currentSound.current = null;
    }
    isProcessing.current = false;
  }

  // ── Pipeline ───────────────────────────────────────────────────────────────

  const processRecording = useCallback(async () => {
    if (isProcessing.current) return;
    isProcessing.current = true;
    const myGen = ++processingGen.current;
    const stale = () => processingGen.current !== myGen;

    const audioUri = await stopRecording();
    if (!audioUri) {
      if (mounted.current) { setError('No audio captured. Something went off course.'); setStatus('error'); }
      isProcessing.current = false;
      return;
    }

    // Switch audio routing before TTS starts — must be awaited or Android plays to wrong device
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    });

    setStatus('processing');

    try {
      const [userText, memoryContext] = await Promise.all([
        transcribeAudio(audioUri),
        fetchMemories(),
      ]);

      if (stale()) return;

      // Filter noise and hallucinations
      if (userText.trim().split(/\s+/).length < 3 || isHallucination(userText)) {
        if (mounted.current) setStatus('idle');
        isProcessing.current = false;
        return;
      }

      addTurn('user', userText);

      // ── Voice selection ────────────────────────────────────────────────────
      const voiceMatch = userText.match(new RegExp(`(?:set|use|switch|change)(?:\\s+(?:voice|to|voice\\s+to))?\\s+(${TTS_VOICES.join('|')})`, 'i'));
      if (voiceMatch) {
        const requested = voiceMatch[1].toLowerCase() as TtsVoice;
        const idx = TTS_VOICES.indexOf(requested);
        if (idx !== -1) {
          voiceIndex.current = idx;
          const reply = `Switched to ${requested}.`;
          if (mounted.current) addTurn('assistant', reply);
          if (mounted.current) setStatus('speaking');
          const uri = await synthesizeSpeech(reply, 'tts-response.mp3', requested);
          await playSound(uri);
        } else {
          const reply = `Unknown voice. Options: ${TTS_VOICES.join(', ')}.`;
          if (mounted.current) addTurn('assistant', reply);
          if (mounted.current) setStatus('speaking');
          const uri = await synthesizeSpeech(reply, 'tts-response.mp3', currentVoice());
          await playSound(uri);
        }
        await new Promise<void>(r => setTimeout(r, 200));
        const vs = await startRecording();
        if (mounted.current) setStatus(vs ? 'listening' : 'idle');
        isProcessing.current = false;
        return;
      }

      // ── Voice-commanded saves ───────────────────────────────────────────────
      const saveMatch =
        userText.match(/^save\s+(?:a\s+)?note[:\-,]?\s*(.+)/i)     ? ['note',     userText.match(/^save\s+(?:a\s+)?note[:\-,]?\s*(.+)/i)![1]]     :
        userText.match(/^save\s+(?:a\s+)?task[:\-,]?\s*(.+)/i)     ? ['task',     userText.match(/^save\s+(?:a\s+)?task[:\-,]?\s*(.+)/i)![1]]     :
        userText.match(/^save\s+(?:a\s+)?decision[:\-,]?\s*(.+)/i) ? ['decision', userText.match(/^save\s+(?:a\s+)?decision[:\-,]?\s*(.+)/i)![1]] :
        userText.match(/^save\s+(?:a\s+)?summary[:\-,]?\s*(.+)/i)  ? ['summary',  userText.match(/^save\s+(?:a\s+)?summary[:\-,]?\s*(.+)/i)![1]]  :
        null;

      if (saveMatch) {
        try {
          await saveEntry(saveMatch[0], saveMatch[1].trim());
        } catch (saveErr: any) {
          if (mounted.current) { setError('Something went off course. Check your connection.'); setStatus('error'); }
          isProcessing.current = false;
          return;
        }
        const replies: Record<string, string> = {
          note:     'Acknowledged. Logged and secured.',
          task:     'Task received. Adding it to the manifest.',
          decision: 'Decision locked in. We\'ll proceed accordingly.',
          summary:  'Summary received. Stored and ready for deployment.',
        };
        const reply = replies[saveMatch[0]] ?? 'Handled.';
        if (mounted.current) addTurn('assistant', reply);
        if (mounted.current) setStatus('speaking');
        const uri = await synthesizeSpeech(reply, 'tts-response.mp3', currentVoice());
        await playSound(uri);
        await new Promise<void>(r => setTimeout(r, 200));
        const savedStarted = await startRecording();
        if (mounted.current) setStatus(savedStarted ? 'listening' : 'idle');
        isProcessing.current = false;
        return;
      }

      // ── Normal GPT flow ─────────────────────────────────────────────────────
      streamAbort.current?.abort();
      streamAbort.current = new AbortController();
      const ttsQueue: Promise<string>[] = [];
      const assistantText = await streamChatResponse(
        history.current.slice(-4),
        memoryContext,
        (sentence) => {
          ttsQueue.push(synthesizeSpeech(sentence, `tts-chunk-${ttsQueue.length}.mp3`, currentVoice()));
        },
        streamAbort.current.signal,
      );

      if (stale()) return;

      history.current.push({ role: 'assistant', content: assistantText });
      if (mounted.current) setTranscript(prev => [...prev, { id: `${Date.now()}-assistant`, role: 'assistant', text: assistantText }]);

      if (mounted.current) setStatus('speaking');
      for (const uriPromise of ttsQueue) {
        if (stale()) return;
        const uri = await uriPromise;
        if (stale()) return;
        await playSound(uri);
      }

      if (stale()) return;
      extractAndSaveMemory(userText, assistantText);
      await new Promise<void>(r => setTimeout(r, 200));
      const started = await startRecording();
      if (mounted.current) setStatus(started ? 'listening' : 'idle');
      isProcessing.current = false;

    } catch (err: any) {
      if (err?.name === 'AbortError') { isProcessing.current = false; return; }
      console.error('[useVoiceAssistant]', err);
      if (mounted.current) { setError(err?.message ?? 'Something went wrong. Check your API key and network.'); setStatus('error'); }
      isProcessing.current = false;
    }
  }, [stopRecording, startRecording]);

  // ── Silence detection ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!isRecording || metering === undefined || status !== 'listening') return;

    if (metering > SPEECH_THRESHOLD_DB) {
      speechSamples.current += 1;
      if (speechSamples.current >= SPEECH_CONFIRM_SAMPLES && !hasSpoken.current) {
        hasSpoken.current = true;
        speechStart.current = Date.now();
      }
      silenceStart.current = null;
    } else if (hasSpoken.current) {
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
    if (status === 'listening') {
      processRecording();
    } else if (status === 'speaking' || status === 'processing') {
      interrupt();
      setError(null);
      setStatus('idle');
    } else if (status === 'idle' || status === 'error') {
      setError(null);
      const started = await startRecording();
      if (started) {
        setStatus('listening');
      } else {
        setError('Microphone access denied. Enable it in Android Settings → Apps → R3-D2 → Permissions.');
        setStatus('error');
      }
    }
  }, [status, startRecording, processRecording]);

  return { status, transcript, error, handlePress };
}
