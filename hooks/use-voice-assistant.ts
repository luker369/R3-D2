/**
 * hooks/use-voice-assistant.ts
 *
 * Orchestrates the full voice loop:
 *   tap → record → (silence auto-stops) → Whisper → GPT → TTS → speak → idle
 */

import {
    startForegroundService,
    stopForegroundService,
} from "@/services/foreground-service";
import {
    clearTokens as clearGoogleTokens,
    isSignedIn as isGoogleSignedIn,
} from "@/services/google-auth";
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from "expo-av";
import {
    createCalendarEvent,
    ensureCalendarWritable,
    fetchCalendarContext,
} from "@/services/google-calendar";
import { detectConfirmation } from "@/lib/confirmation";
import {
    fetchRecentEmails,
    fetchUnreadEmails,
    getAccountLabels,
    replyToThread,
    sendEmail,
    type GmailMessage,
} from "@/services/gmail";
import {
    deriveSubject,
    detectEmailCommand,
    normalizeSpokenAddress,
} from "@/lib/email-commands";
import { detectSynthesisCommand } from "@/lib/synthesis-commands";
import { runDailySynthesis } from "@/services/daily-synthesis";
import {
    extractAndSaveMemory,
    fetchMemories,
    fetchSystemSettings,
    saveEntry,
    saveSystemSetting,
} from "@/services/memory";
import {
    getChatResponse,
    streamChatResponse,
    synthesizeSpeech,
    transcribeAudio,
    TTS_VOICES,
    type Message,
    type TtsVoice,
} from "@/services/openai";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, DeviceEventEmitter, Linking, type AppStateStatus } from "react-native";
import { onAudioFrame } from "@/services/audio-stream";
import { isHallucination, stripHallucinationSentences } from "@/lib/hallucinations";
import { detectTaskCommand } from "@/lib/task-commands";
import { detectReminderCommand } from "@/lib/reminder-commands";
import { formatReminderTime, parseReminderTime } from "@/lib/reminder-time";
import {
  completeTaskByTitle,
  createTask,
  listOpenTasks,
} from "@/services/tasks";
import {
  createReminder,
  listTodayReminders,
} from "@/services/reminders";
import { useGoogleSignIn } from "./use-google-auth";
import { useVoiceRecorder } from "./use-voice-recorder";

// ─── Silence detection config ─────────────────────────────────────────────────

const SILENCE_DURATION_MS = 900;
const SPEECH_CONFIRM_SAMPLES = 3; // 300ms of sustained sound before arming
const MIN_SPEECH_DURATION_MS = 300; // must speak for at least 0.3s total
const POST_RESTART_GRACE_MS = 400; // ignore mic briefly after recorder restarts (prevents TTS bleed from triggering)
const SPEECH_MARGIN_DB = 10; // dB above ambient floor to count as speech
const AMBIENT_ALPHA = 0.05; // EMA smoothing: lower = slower adaptation

// ─── Types ────────────────────────────────────────────────────────────────────

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  imageUri?: string;
};

export type AssistantStatus =
  | "idle"
  | "listening"
  | "processing"
  | "speaking"
  | "error";

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVoiceAssistant() {
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<{
    uri: string;
    base64: string;
  } | null>(null);

  const history = useRef<Message[]>([]);
  const historySummary = useRef<string>("");
  const hasSpoken = useRef(false);
  const speechSamples = useRef(0);
  const speechStart = useRef<number | null>(null);
  const silenceStart = useRef<number | null>(null);
  const ambientDb = useRef<number>(-42);
  const recordingStartedAt = useRef<number>(0);
  const isProcessing = useRef(false);
  const streamAbort = useRef<AbortController | null>(null);
  const processingGen = useRef(0);
  const turnsSinceCompress = useRef(0);

  // Two-turn calendar confirmation: on a calendar utterance we parse, stash
  // the proposed event here, and speak a summary + "Should I create it?". The
  // next turn's yes/no is matched against this; anything else clears it and
  // falls through to normal processing. TTL prevents a stale pending from
  // eating a much-later "yes" meant for something else.
  const pendingCalendarEvent = useRef<{
    title: string;
    startDate: Date;
    endDate: Date;
    allDay?: boolean;
    location?: string;
    expiresAt: number;
  } | null>(null);
  const PENDING_CAL_TTL_MS = 60_000;

  // Populated after an inbox-read turn — lets "reply to that email" know which
  // thread to hit. 5-min TTL so a stale reference doesn't silently attach to a
  // reply the user meant for a different context.
  const lastDiscussedEmail = useRef<{
    threadId: string;
    from: string;
    subject: string;
    account: string | undefined;
    expiresAt: number;
  } | null>(null);
  const LAST_EMAIL_TTL_MS = 5 * 60_000;

  // Two-turn email confirmation, mirror of pendingCalendarEvent. The draft is
  // built on the first turn, spoken back, and held here until the user says
  // yes/no. TTL shorter than calendar because a pending send is riskier than
  // a pending event create.
  const pendingEmail = useRef<
    | {
        kind: 'draft';
        to: string;
        subject: string;
        body: string;
        account: string | undefined;
        expiresAt: number;
      }
    | {
        kind: 'reply';
        threadId: string;
        replyingTo: string;
        body: string;
        account: string | undefined;
        expiresAt: number;
      }
    | null
  >(null);
  const PENDING_EMAIL_TTL_MS = 60_000;
  // Monotonic turn counter for diagnostics — lets us spot whether audio wedge
  // correlates with turn count or with elapsed time.
  const turnNumber = useRef(0);
  const isLooping = useRef(false);
  const [looping, setLooping] = useState(false);
  const mounted = useRef(true);
  const voiceIndex = useRef(TTS_VOICES.indexOf("cedar"));
  const currentVoice = (): TtsVoice => TTS_VOICES[voiceIndex.current];
  const volumeLevel = useRef(1.0);
  const lastProgressAt = useRef<number>(0);
  const bumpProgress = () => {
    lastProgressAt.current = Date.now();
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Safety net only — under normal navigation this hook lives for the
      // app's lifetime. If something tears it down mid-turn (dev reload,
      // future multi-screen nav), we still want the in-flight stream and
      // native player released and the FGS dropped so we don't leak a
      // background mic-permitted notification.
      streamAbort.current?.abort();
      if (currentSound.current) {
        console.log("[BG-AUDIO] currentSound cleared by=unmount-cleanup");
        try { currentSound.current.remove(); } catch {}
        currentSound.current = null;
      }
      if (isLooping.current) void stopForegroundService();
    };
  }, []);

  const { startRecording, stopRecording, isRecording, isRecordingRef } =
    useVoiceRecorder();

  const statusRef = useRef<AssistantStatus>(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Single chokepoint for status changes. Logs every transition synchronously
  // at the call site (so reason/origin is visible) and defers to setStatus.
  // Replaces the prior useEffect-based render-time transition log; one log
  // per transition, with reason and turn id for correlation.
  const setStatusSafe = useCallback(
    (next: AssistantStatus, reason?: string) => {
      const prev = statusRef.current;
      if (prev === next) return;
      // Keep the ref in lockstep with the setter. The useEffect above also
      // syncs on render, but synchronous callers (e.g. finishTurnToListening's
      // post-resume log) would otherwise read a stale value for one tick.
      statusRef.current = next;
      console.log(
        `[VA STATE] turn=${turnNumber.current} ${prev} -> ${next}` +
          (reason ? ` (${reason})` : "") +
          ` looping=${isLooping.current} isProcessing=${isProcessing.current}`,
      );
      setStatus(next);
    },
    [],
  );

  const resumeLoopRef = useRef<() => Promise<void>>(async () => {});
  const appWasInBackgroundRef = useRef(false);

  // ── The gate ──────────────────────────────────────────────────────────────
  // Mathematically serializes all recorder starts so concurrent callers
  // (auto-start timer, assist-gesture URL handler, AppState resume,
  // user press) cannot race the native recorder. Rule: startRecording()
  // may only be called from inside ensureListeningLocked().
  //
  //   - startInFlightRef + startPromiseRef form the mutex.
  //   - startEpochRef ensures only the current owner clears the lock
  //     in finally — protects against a stale finally clearing a newer
  //     owner's lock if epochs ever wrap or interleave.
  //
  // On success the gate sets status=listening. On failure it unrolls
  // isLooping; the caller decides whether failure means "idle" (auto-start,
  // resumeLoop) or "error" (press, assist). FGS lifecycle and custom error
  // messages remain at the call sites.
  const startInFlightRef = useRef(false);
  const startPromiseRef = useRef<Promise<boolean> | null>(null);
  const startEpochRef = useRef(0);

  const ensureListeningLocked = useCallback(
    async (reason: string): Promise<boolean> => {
      // Branch 1: already active — short-circuit success.
      if (isRecordingRef.current && statusRef.current === "listening") {
        console.log(`[VA GATE ${reason}] short-circuit: already listening+recording`);
        return true;
      }

      // Branch 2: another start is in flight — join its result.
      if (startInFlightRef.current && startPromiseRef.current) {
        console.log(`[VA GATE ${reason}] join: another start in flight`);
        const joined = await startPromiseRef.current;
        console.log(`[VA GATE ${reason}] join result =>`, joined);
        return joined;
      }

      // Branch 3: become the owner.
      startInFlightRef.current = true;
      const myEpoch = ++startEpochRef.current;
      console.log(`[VA GATE ${reason}] acquired lock epoch=${myEpoch}`);

      // Assert loop intent before native call so a concurrent observer
      // sees we're starting, not stopped.
      isLooping.current = true;
      setLooping(true);

      const work = (async (): Promise<boolean> => {
        try {
          const started = await startRecording();
          console.log(
            `[VA GATE ${reason}] startRecording =>`,
            started,
            `recorderRunning=`,
            isRecordingRef.current,
            `epoch=${myEpoch}`,
          );

          // Branch 4 + 5: true success or race-loser-success
          // (startRecording returned false but recorder is running because
          // a concurrent call won the native race — same outcome for us).
          if (started || isRecordingRef.current) {
            if (mounted.current) {
              setStatusSafe(
                "listening",
                `gate:${reason}${started ? "" : ":race-winner"}`,
              );
            }
            console.log(
              `[VA GATE ${reason}] listening-restarted epoch=${myEpoch}`,
            );
            return true;
          }

          // Branch 6: real failure — recorder genuinely not running.
          console.log(`[VA GATE ${reason}] real failure`);
          isLooping.current = false;
          setLooping(false);
          return false;
        } catch (e) {
          // Branch 7: exception path
          console.warn(`[VA GATE ${reason}] threw:`, e);
          isLooping.current = false;
          setLooping(false);
          return false;
        } finally {
          // Only the current owner clears the lock.
          if (startEpochRef.current === myEpoch) {
            startInFlightRef.current = false;
            startPromiseRef.current = null;
            console.log(`[VA GATE ${reason}] released lock epoch=${myEpoch}`);
          } else {
            console.log(
              `[VA GATE ${reason}] epoch superseded (current=${startEpochRef.current}, mine=${myEpoch}) — not clearing lock`,
            );
          }
        }
      })();

      startPromiseRef.current = work;
      return work;
    },
    [setStatusSafe, startRecording, isRecordingRef],
  );

  const ensureListeningLockedRef = useRef(ensureListeningLocked);
  ensureListeningLockedRef.current = ensureListeningLocked;

  // Google OAuth — triggered by voice command ("connect Gmail", "sign into Google")
  const promptGoogleSignIn = useGoogleSignIn({
    onConnected: () => {
      if (!mounted.current) return;
      speakAndFinish("Google connected. Gmail and calendar access ready.");
    },
    onError: (msg) => {
      if (!mounted.current) return;
      setError(`Google sign-in: ${msg}`);
    },
  });

  // Auto-start listening after startup sound finishes
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!mounted.current) return;
      console.log("[VA] auto-start firing (3s post-mount)");
      await startForegroundService();
      const ok = await ensureListeningLockedRef.current("auto-start");
      if (!ok && mounted.current) {
        setStatusSafe("idle", "auto-start:fail");
        stopForegroundService();
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  const MAX_TRANSCRIPT = 50;

  function addTurn(
    role: "user" | "assistant",
    text: string,
    imageUri?: string,
  ) {
    setTranscript((prev) => {
      const next = [
        ...prev,
        { id: `${Date.now()}-${role}`, role, text, imageUri },
      ];
      return next.length > MAX_TRANSCRIPT ? next.slice(-MAX_TRANSCRIPT) : next;
    });
    history.current.push({ role, content: text });
  }

  const currentSound = useRef<any>(null);

  async function setPlaybackSessionActive(active: boolean) {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: active,
      staysActiveInBackground: active,
      interruptionModeIOS: active
        ? InterruptionModeIOS.DoNotMix
        : InterruptionModeIOS.MixWithOthers,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    });
  }

  /**
   * Play a TTS audio file. Two watchdogs guard long-session degradation:
   *
   *   FIRST_PROGRESS_MS (2s)  — if .play() was called but no progress event
   *     ever arrived, treat as a silent-failure (Android has been observed
   *     to accept .play() and return without producing audio after many turns).
   *     Trigger hardAudioReset + retry once. If the retry also fails, reject
   *     so speakAndFinish can surface an error — never silently continue.
   *
   *   STALL_MS (8s)           — ONLY armed after first progress arrived. Guards
   *     against players that start, then freeze mid-playback. A freeze here is
   *     treated as successful completion (we've already emitted audible audio).
   *
   * Every lifecycle transition logs: start, first-progress, end, failure.
   */
  async function playSound(uri: string, retry: number = 0): Promise<void> {
    await hardAudioReset("pre-play");
    if (isLooping.current) {
      try {
        // shouldPlayInBackground=true paired with MEDIA_PLAYBACK in the FGS
        // service types (see services/foreground-service.ts). Without the
        // FGS type, Android 14+ silently rejected the audio session and the
        // player stalled (ready -> idle, currentTime never advanced) the
        // moment the app was hidden.
        await setPlaybackSessionActive(true);
      } catch (e: any) {
        console.warn("[VA] playSound setPlaybackSessionActive threw:", e?.message);
      }
    }
    const player = new Audio.Sound();
    const psAppState = AppState.currentState;
    currentSound.current = player;
    console.log(`[BG-AUDIO] currentSound set by=playSound retry=${retry}`);
    return new Promise((resolve, reject) => {
      // Background ExoPlayer callback delivery is deprioritized — first
      // playbackStatusUpdate can legitimately take 3-5s to arrive even when
      // audio is playing fine. 2s foreground is plenty; 6s background avoids
      // false NO_AUDIO retries on a healthy stream.
      const FIRST_PROGRESS_MS = psAppState === "active" ? 2_000 : 6_000;
      const STALL_MS = 8_000;
      let firstProgressAt: number | null = null;
      let lastProgressAt = Date.now();
      let updateCount = 0;
      let lastPlaybackState: string | undefined;
      let lastStatus: any = null;
      let maxCurrentTime = 0;
      // Idempotency guard. finish/failNoAudio can each be reached from multiple
      // concurrent paths (watchdog timers, didJustFinish event, parallel
      // interrupt). This prevents double-resolve and double-remove of the
      // native player.
      let settled = false;

      const cleanupTimers = () => {
        clearTimeout(firstProgressWatchdog);
        clearInterval(stallCheck);
        player.setOnPlaybackStatusUpdate(null);
      };

      const teardownPlayer = () => {
        if (currentSound.current === player) {
          console.log("[BG-AUDIO] currentSound cleared by=teardownPlayer settled=true");
          currentSound.current = null;
        }
        try {
          const stopPromise = player.stopAsync() as Promise<unknown>;
          stopPromise.catch(() => {});
        } catch {}
        try {
          const unloadPromise = player.unloadAsync() as Promise<unknown>;
          unloadPromise.catch(() => {});
        } catch {}
      };

      const finishSuccess = (source: string) => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        teardownPlayer();
        console.log(
          "[BG-AUDIO] playSound end source=",
          source,
          "appState=",
          AppState.currentState,
          "updates=",
          updateCount,
          "maxCurrentTime=",
          maxCurrentTime,
        );
        resolve();
      };

      const failNoAudio = async (reason: string) => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        teardownPlayer();
        console.warn(
          "[BG-AUDIO] playSound NO_AUDIO reason=",
          reason,
          "appState=",
          AppState.currentState,
          "retry=",
          retry,
          "updates=",
          updateCount,
          "firstProgressMs=",
          FIRST_PROGRESS_MS,
          "lastStatus=",
          lastStatus,
        );
        await hardAudioReset("no-audio-fail");
        if (retry < 1) {
          console.warn("[VA] playSound retry 1/1");
          try {
            await playSound(uri, retry + 1);
            resolve();
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`no_audio_after_retry:${reason}`));
        }
      };

      const firstProgressWatchdog = setTimeout(() => {
        if (firstProgressAt === null && !settled) {
          void failNoAudio("no-first-progress-2s");
        }
      }, FIRST_PROGRESS_MS);

      const stallCheck = setInterval(() => {
        // Only arm the stall check after REAL first progress (currentTime > 0).
        // Before that, the first-progress watchdog is authoritative. A stall
        // here means the player froze mid-playback — audible audio was
        // already emitted — so treat it as a graceful finish.
        if (firstProgressAt !== null && Date.now() - lastProgressAt > STALL_MS) {
          if (maxCurrentTime <= 0) {
            // Defensive: should be unreachable since firstProgressAt now
            // only sets when currentTime>0. If it ever fires, treat as
            // NO_AUDIO, not success.
            console.warn(
              "[BG-AUDIO] playSound stall but maxCurrentTime=0 — treating as NO_AUDIO",
            );
            void failNoAudio("stall-zero-currentTime");
            return;
          }
          console.warn(
            "[BG-AUDIO] playSound stalled (no progress for 8s post-start), finishing updates=",
            updateCount,
            "maxCurrentTime=",
            maxCurrentTime,
          );
          finishSuccess("stall-after-progress");
        }
      }, 2000);

      player.setOnPlaybackStatusUpdate((status: any) => {
        updateCount++;
        lastStatus = status;
        const currentTime =
          typeof status?.positionMillis === "number" ? status.positionMillis / 1000 : 0;
        const duration =
          typeof status?.durationMillis === "number" ? status.durationMillis / 1000 : 0;
        if (currentTime > maxCurrentTime) {
          maxCurrentTime = currentTime;
        }
        if (updateCount <= 20) {
          console.log(
            `[BG-AUDIO] playSound evt# ${updateCount} isLoaded=${status?.isLoaded} isPlaying=${status?.isPlaying} isBuffering=${status?.isBuffering} ct=${currentTime} dur=${duration} didJustFinish=${status?.didJustFinish} error=${status?.error ?? "null"}`,
          );
        }
        if (firstProgressAt === null && maxCurrentTime > 0) {
          firstProgressAt = Date.now();
          lastProgressAt = Date.now();
          console.log(
            "[BG-AUDIO] playSound first-real-progress appState=",
            AppState.currentState,
            "updates=",
            updateCount,
            "isLoaded=",
            status?.isLoaded,
            "currentTime=",
            currentTime,
          );
        } else if (firstProgressAt !== null) {
          lastProgressAt = Date.now();
        }
        const playbackState = `${status?.isLoaded}:${status?.isPlaying}:${status?.isBuffering}`;
        if (playbackState !== lastPlaybackState) {
          console.log(
            "[VA] playSound state change #",
            updateCount,
            lastPlaybackState,
            "->",
            playbackState,
            "playing=",
            status?.isPlaying,
            "isLoaded=",
            status?.isLoaded,
            "currentTime=",
            currentTime,
            "duration=",
            duration,
          );
          lastPlaybackState = playbackState;
        }
        if (status?.error) {
          void failNoAudio(`status-error:${status.error}`);
          return;
        }
        if (status.didJustFinish) finishSuccess("didJustFinish");
      });

      void (async () => {
        try {
          const loadStatus = await player.loadAsync(
            { uri },
            {
              shouldPlay: false,
              volume: volumeLevel.current,
              progressUpdateIntervalMillis: 250,
            },
            false,
          );
          console.log(
            "[BG-AUDIO] playSound player-created retry=",
            retry,
            "appState=",
            psAppState,
            "isLoaded=",
            loadStatus.isLoaded,
            "duration=",
            loadStatus.isLoaded ? loadStatus.durationMillis / 1000 : 0,
            "volume=",
            volumeLevel.current,
          );
          console.log(
            "[BG-AUDIO] playSound play() called appState=",
            AppState.currentState,
            "isLoaded=",
            loadStatus.isLoaded,
          );
          const playStatus = await player.playAsync();
          console.log(
            "[VA] playSound post-play snapshot playing=",
            playStatus.isLoaded ? playStatus.isPlaying : false,
            "isLoaded=",
            playStatus.isLoaded,
          );
        } catch (e: any) {
          console.warn("[VA] playSound player.play() threw:", e?.message);
          void failNoAudio(`play-threw:${e?.message ?? "unknown"}`);
        }
      })();
    });
  }

  async function resumeLoop() {
    console.log(
      "[VA] resumeLoop entry isLooping=",
      isLooping.current,
      "mounted=",
      mounted.current,
    );
    if (!isLooping.current || !mounted.current) return;
    let ok = await ensureListeningLockedRef.current("resumeLoop");
    if (!ok && mounted.current) {
      await new Promise<void>((r) => setTimeout(r, 250));
      ok = await ensureListeningLockedRef.current("resumeLoop:retry");
    }
    if (!ok && mounted.current) setStatusSafe("idle", "resumeLoop:fail");
  }

  // Single exit point for every turn-completion path. Guarantees that if the
  // loop is still intended (`isLooping.current`), we always attempt to return
  // to listening — no silent dead-ends. The post-resume log tells us whether
  // the mic actually came back up, which is what the user notices.
  async function finishTurnToListening(reason: string): Promise<void> {
    console.log(
      `[VA] finishTurnToListening reason=${reason} isLooping=${isLooping.current} mounted=${mounted.current}`,
    );
    if (!mounted.current) return;
    if (isLooping.current) {
      await resumeLoop();
      console.log(
        `[VA] finishTurnToListening post-resume reason=${reason} status=${statusRef.current} recording=${isRecordingRef.current}`,
      );
    } else {
      setStatusSafe("idle", `finishTurn:${reason}`);
    }
  }

  resumeLoopRef.current = resumeLoop;

  // Track background transitions. Do NOT attempt to start FGS from background —
  // Android 12+ throws ForegroundServiceStartNotAllowedException. FGS must already
  // be running before the app is backgrounded; it's started at loop-start while active.
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === "background") {
        appWasInBackgroundRef.current = true;
        console.log("[VA] AppState -> background; FGS running:", isLooping.current);
        return;
      }
      if (
        next === "active" &&
        appWasInBackgroundRef.current &&
        isLooping.current
      ) {
        appWasInBackgroundRef.current = false;
        const s = statusRef.current;
        const rec = isRecordingRef.current;
        if (s === "listening" && !rec) {
          setTimeout(() => {
            void resumeLoopRef.current();
          }, 450);
        }
      }
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => sub.remove();
  }, []);

  /**
   * Fully tear down the audio path and release focus. Call:
   *   - before every new playback (so the next player starts clean)
   *   - after any playback failure
   *   - from interrupt()
   *
   * The player pause/remove is effectively synchronous; the audio-mode drop
   * is the only async part. Safe to call with no current player (no-op on
   * the player side; still releases focus).
   */
  async function hardAudioReset(reason: string): Promise<void> {
    const had = !!currentSound.current;
    console.log(
      `[BG-AUDIO] hardAudioReset reason=${reason} hadPlayer=${had} appState=${AppState.currentState}`,
    );
    if (currentSound.current) {
      console.log(`[BG-AUDIO] currentSound cleared by=hardAudioReset:${reason}`);
      try { await currentSound.current.stopAsync?.(); }
      catch (e: any) { console.warn("[VA] hardAudioReset stopAsync threw:", e?.message); }
      try { await currentSound.current.unloadAsync?.(); }
      catch (e: any) { console.warn("[VA] hardAudioReset unloadAsync threw:", e?.message); }
      currentSound.current = null;
    }
    // Drop the playback session even without a current player. Android can keep
    // a stale audio state across turns, and the next player then transitions
    // ready -> idle with currentTime still 0.
    try {
      await setPlaybackSessionActive(false);
    } catch (e: any) {
      console.warn("[VA] hardAudioReset setPlaybackSessionActive threw:", e?.message);
    }
  }

  function interrupt() {
    processingGen.current += 1;
    isProcessing.current = false;
    streamAbort.current?.abort();
    // Fire-and-forget: next playSound will hardAudioReset again, but doing it
    // here too makes the transition between turns explicit. The sync player
    // cleanup inside hardAudioReset happens before the async mode-set awaits.
    void hardAudioReset("interrupt");
    isProcessing.current = false;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function releasePlaybackAudio() {
    await setPlaybackSessionActive(false);
  }

  async function speakAndFinish(reply: string, voice?: TtsVoice) {
    // try/finally guarantees isProcessing clears even if synth/play/release throws.
    // Without this, a single TTS or playback failure leaks isProcessing=true
    // and blocks every subsequent turn at the processRecording entry guard.
    try {
      if (mounted.current) addTurn("assistant", reply);
      if (mounted.current) setStatusSafe("speaking", "speakAndFinish");
      const uri = await synthesizeSpeech(
        reply,
        "tts-response.mp3",
        voice ?? currentVoice(),
      );
      // playSound has its own first-progress watchdog + one retry. If both
      // attempts fail, surface an error state — NEVER silently continue the
      // turn as though we spoke.
      let playbackFailed = false;
      try {
        await playSound(uri);
      } catch (e: any) {
        console.warn("[VA] speakAndFinish playback failed after retry:", e?.message);
        await hardAudioReset("speakAndFinish-fail");
        if (mounted.current) setError("Audio playback failed. Tap to retry.");
        playbackFailed = true;
        // Fall through — still attempt to return to listening so a single
        // failed recovery line doesn't leave the mic dead.
      }
      try {
        await releasePlaybackAudio();
      } catch (e: any) {
        console.warn("[VA] releasePlaybackAudio threw (speakAndFinish):", e?.message);
      }
      const delay = Math.min(800, 300 + reply.split(/\s+/).length * 20);
      await new Promise<void>((r) => setTimeout(r, delay));
      await finishTurnToListening(
        playbackFailed ? "speakAndFinish:playback-failed" : "speakAndFinish:end",
      );
    } finally {
      isProcessing.current = false;
      console.log("[VA] speakAndFinish finally: isProcessing=false");
    }
  }

  // Rarely-used silent-chat path. Bypasses transcription/wake-word/hallucination
  // filter/command detection — typed text doesn't have those problems. Also
  // skips memory/calendar injection for simplicity; typed chat is best-effort.
  async function sendText(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    if (isProcessing.current || isRecordingRef.current) {
      console.log("[VA] sendText ignored: busy");
      return;
    }
    const imageSnap = pendingImage;
    if (imageSnap) setPendingImage(null);
    addTurn("user", text, imageSnap?.uri);
    isProcessing.current = true;
    if (mounted.current) setStatusSafe("processing", "sendText");
    try {
      const reply = await getChatResponse(history.current);
      if (!mounted.current) return;
      await speakAndFinish(reply);
    } catch (e: any) {
      console.warn("[VA] sendText failed:", e?.message);
      isProcessing.current = false;
      if (mounted.current) setStatusSafe("idle", "sendText:fail");
    }
  }

  function isGmailReadCommand(text: string): boolean {
    const t = text.toLowerCase().trim();
    // Must reference mail/inbox AND have a read/check-style verb or interrogative.
    const MAIL = '(?:e-?mail|emails|e-?mails|gmail|gmai|g-?mail|inbox|mail|messages|mails)';
    if (new RegExp(`\\b(?:check|read|show|get|fetch|summar(?:ize|ise)|list)\\b.*\\b${MAIL}\\b`).test(t)) return true;
    if (new RegExp(`\\b(?:what(?:'s|s|\\s+is)?|any|anything)\\b.*\\b(?:new|unread|recent)?\\b.*\\b${MAIL}\\b`).test(t)) return true;
    if (new RegExp(`\\b(?:any\\s+new|any\\s+unread|new)\\b.*\\b${MAIL}\\b`).test(t)) return true;
    if (new RegExp(`^(?:in\\s+my\\s+)?${MAIL}$`).test(t)) return false; // bare mention not a command
    return false;
  }

  function isUnreadVariant(text: string): boolean {
    return /\b(?:unread|new|fresh)\b/i.test(text);
  }

  // If the user named a specific Gmail account (e.g. "check my work email"),
  // return that label; else null to query all accounts merged.
  function detectGmailAccountLabel(text: string): string | undefined {
    const labels = getAccountLabels();
    if (labels.length <= 1) return undefined;
    const lower = text.toLowerCase();
    for (const label of labels) {
      // Word-boundary match; escape regex metachars in label names.
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`, "i").test(lower)) return label;
    }
    return undefined;
  }

  function isGoogleSignInCommand(text: string): boolean {
    const t = text.toLowerCase().trim();
    const TARGET = '(?:google|gmail|gmai|g-?mail|e-?mail)';
    if (new RegExp(`\\b(?:sign|log)\\s*(?:in|into)\\b.*\\b${TARGET}\\b`).test(t))
      return true;
    if (new RegExp(`\\bconnect\\b.*\\b(?:${TARGET}|my\\s+account)\\b`).test(t))
      return true;
    if (new RegExp(`\\b(?:link|authorize|authorise|hook\\s*up|set\\s*up|add)\\b.*\\b${TARGET}\\b`).test(t))
      return true;
    // Bare fragments — user clipped by recorder start grace. No other gmail verb yet, so "my gmail" alone means connect.
    if (/^(?:my\s+)?(?:gmail|gmai|g-?mail)\.?$/.test(t)) return true;
    return false;
  }

  function isGoogleSignOutCommand(text: string): boolean {
    const t = text.toLowerCase().trim();
    if (/\b(?:sign|log)\s*out\b.*\b(?:google|gmail)\b/.test(t)) return true;
    if (/\bdisconnect\b.*\b(?:google|gmail)\b/.test(t)) return true;
    return false;
  }

  function isCalendarCommand(text: string): boolean {
    const t = text.toLowerCase().trim();
    if (/\b(?:on|to|in)\s+(?:my\s+)?(?:calendar|schedule|agenda)\b/.test(t))
      return true;
    if (
      /^(?:schedule|book|create|add|set\s*up|put|plan)\s+(?:a\s+|an\s+|my\s+)?(?:meeting|event|appointment|call|reminder|lunch|dinner|breakfast|coffee)\b/.test(
        t,
      )
    )
      return true;
    if (/^(?:schedule|book)\s+/.test(t)) return true;
    if (/\bcalendar\s+(?:event|entry|item)\b/.test(t)) return true;
    return false;
  }

  type ParsedEvent = {
    title: string;
    startISO: string;
    endISO: string;
    allDay?: boolean;
    location?: string;
  };

  async function parseEventFromSpeech(
    utterance: string,
  ): Promise<ParsedEvent | null> {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const prompt =
      `Extract a calendar event from this spoken request. Return ONLY valid JSON, no prose.\n\n` +
      `Current local time: ${now.toString()}\n` +
      `Timezone: ${tz}\n\n` +
      `Fields:\n` +
      `- title: short, clean event title (no filler like "a meeting called")\n` +
      `- startISO: ISO 8601 with offset (e.g. 2026-04-19T14:00:00-07:00)\n` +
      `- endISO: ISO 8601 with offset; default 1 hour after start if not specified\n` +
      `- allDay: true only if the user said "all day" or gave a date with no time\n` +
      `- location: optional, only if explicitly mentioned\n\n` +
      `If the request is ambiguous or lacks a clear date/time, return: {"error":"<brief reason>"}\n\n` +
      `Request: "${utterance}"`;

    try {
      const raw = await getChatResponse(
        [{ role: "user", content: prompt }],
        undefined,
        undefined,
        "gpt-5.4-mini",
        { jsonMode: true },
      );
      const parsed = JSON.parse(raw);
      if (parsed.error || !parsed.title || !parsed.startISO || !parsed.endISO)
        return null;
      const start = new Date(parsed.startISO);
      const end = new Date(parsed.endISO);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
      return {
        title: String(parsed.title).trim(),
        startISO: parsed.startISO,
        endISO: parsed.endISO,
        allDay: !!parsed.allDay,
        location: parsed.location ? String(parsed.location).trim() : undefined,
      };
    } catch (e) {
      console.warn("[VA] parseEventFromSpeech failed:", e);
      return null;
    }
  }

  async function summarizeEmailsForVoice(
    emails: GmailMessage[],
    unreadOnly: boolean,
  ): Promise<string> {
    const accountsPresent = new Set(emails.map(e => e.account).filter(Boolean));
    const multiAccount = accountsPresent.size > 1;
    const lines = emails
      .map((e, i) => {
        const when = new Date(e.date).toLocaleString('en-US', {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        });
        const acc = e.account ? `\n   Account: ${e.account}` : '';
        return `${i + 1}. From: ${e.from}${acc}\n   Subject: ${e.subject}\n   When: ${when}\n   Snippet: ${e.snippet}`;
      })
      .join('\n\n');
    const accountHint = multiAccount
      ? `These come from multiple Gmail accounts (${Array.from(accountsPresent).join(', ')}). When useful, mention which account something is from. `
      : '';
    const prompt =
      `Summarize these ${unreadOnly ? 'unread' : 'recent'} emails for the user by voice in 3-5 short sentences. ` +
      `Lead with the count, then highlight what matters (urgent, time-sensitive, from known people). ` +
      accountHint +
      `Use natural spoken English — no bullet points, no formatting symbols. Keep it tight.\n\n` +
      `Emails:\n${lines}`;
    try {
      const reply = await getChatResponse(
        [{ role: 'user', content: prompt }],
        undefined,
        undefined,
        'gpt-5.4-mini',
      );
      return reply.trim() || `You have ${emails.length} ${unreadOnly ? 'unread' : 'recent'} emails.`;
    } catch (e) {
      console.warn('[VA] summarizeEmailsForVoice failed:', e);
      return `You have ${emails.length} ${unreadOnly ? 'unread' : 'recent'} emails. Couldn't summarize.`;
    }
  }

  function formatEventConfirmation(
    title: string,
    start: Date,
    allDay: boolean,
  ): string {
    const day = start.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    if (allDay) return `Scheduled: ${title}, ${day}, all day.`;
    const time = start.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    return `Scheduled: ${title}, ${day} at ${time}.`;
  }

  // Spoken summary used at the "should I create it?" step — includes end time
  // so the user knows what duration the parser picked (esp. for "two hours for
  // R2 work tonight" where the LLM chose both start and end).
  function formatEventProposal(
    title: string,
    start: Date,
    end: Date,
    allDay: boolean,
    location?: string,
  ): string {
    const day = start.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const loc = location ? ` at ${location}` : "";
    if (allDay) return `${title}, ${day}, all day${loc}`;
    const startTime = start.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    const endTime = end.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    return `${title}, ${day}, ${startTime} to ${endTime}${loc}`;
  }

  function parseSaveCommand(text: string): [string, string] | null {
    let m;
    // Notes
    if (
      (m = text.match(
        /^(?:save|add|log|jot(?:\s+down)?|write(?:\s+down)?|make)\s+(?:a\s+)?note[:\-,]?\s*(.+)/i,
      ))
    )
      return ["note", m[1]];
    if ((m = text.match(/^(?:note|note\s+that)[:\-,]?\s*(.+)/i)))
      return ["note", m[1]];
    if ((m = text.match(/^remember\s+(?:that\s+)?(.+)/i)))
      return ["note", m[1]];
    // Tasks / todos
    if (
      (m = text.match(
        /^(?:save|add|create|log)\s+(?:a\s+)?(?:task|todo|to-do)[:\-,]?\s*(.+)/i,
      ))
    )
      return ["todo", m[1]];
    if (
      (m = text.match(
        /^(?:remind me to|don't forget(?:\s+to)?|I need to|add to my list)[:\-,]?\s*(.+)/i,
      ))
    )
      return ["todo", m[1]];
    // Decisions
    if (
      (m = text.match(/^(?:save|add|log)\s+(?:a\s+)?decision[:\-,]?\s*(.+)/i))
    )
      return ["decision", m[1]];
    if (
      (m = text.match(
        /^(?:we(?:'ve)?\s+decided|I(?:'ve)?\s+decided|decision)[:\-,]?\s*(.+)/i,
      ))
    )
      return ["decision", m[1]];
    // Summaries
    if ((m = text.match(/^(?:save|add|log)\s+(?:a\s+)?summary[:\-,]?\s*(.+)/i)))
      return ["summary", m[1]];
    return null;
  }

  function buildHistorySlice(
    imageSnap: { uri: string; base64: string } | null,
    userText: string,
  ): Message[] {
    const recent = history.current.slice(-12).map((msg, i, arr) => {
      if (imageSnap && i === arr.length - 1 && msg.role === "user") {
        return {
          ...msg,
          content: [
            {
              type: "image_url" as const,
              image_url: {
                url: `data:image/jpeg;base64,${imageSnap.base64}`,
                detail: "auto" as const,
              },
            },
            { type: "text" as const, text: userText },
          ],
        };
      }
      return msg;
    });
    if (!historySummary.current) return recent;
    return [
      {
        role: "system" as const,
        content: `Earlier in this session:\n${historySummary.current}`,
      },
      ...recent,
    ];
  }

  const SUMMARY_MAX_CHARS = 500;

  function compressHistory() {
    const KEEP = 12;
    if (history.current.length <= KEEP + 4) return;
    const toSummarize = history.current.slice(0, history.current.length - KEEP);
    history.current = history.current.slice(-KEEP);
    const lines = toSummarize
      .map(
        (m) =>
          `${m.role === "user" ? "User" : "Assistant"}: ${typeof m.content === "string" ? m.content : "[image message]"}`,
      )
      .join("\n");
    const priorSummary = historySummary.current
      ? `\n\nPrior summary so far:\n${historySummary.current}`
      : "";
    getChatResponse(
      [
        {
          role: "user",
          content:
            `Produce a compact running summary to help continue this conversation. Use this exact format, only including sections that apply:\n` +
            `Facts: <short bullet list of durable facts about the user or topic>\n` +
            `Decisions: <what was resolved or chosen>\n` +
            `Open: <threads or questions left hanging>\n\n` +
            `Keep the total under 400 characters. Merge with any prior summary rather than repeating.${priorSummary}\n\nConversation to fold in:\n${lines}`,
        },
      ],
      undefined,
      undefined,
      "gpt-5.4-mini",
    )
      .then((summary) => {
        const next = summary.trim();
        if (!next) return;
        if (next.length <= SUMMARY_MAX_CHARS) {
          historySummary.current = next;
        } else {
          // Re-summarize the summary itself to keep it bounded
          getChatResponse(
            [
              {
                role: "user",
                content: `Compress this summary to under ${SUMMARY_MAX_CHARS} characters, preserving Facts/Decisions/Open structure:\n\n${next}`,
              },
            ],
            undefined,
            undefined,
            "gpt-5.4-mini",
          )
            .then((compressed) => {
              historySummary.current = compressed
                .trim()
                .slice(0, SUMMARY_MAX_CHARS);
            })
            .catch((err) => {
              // Re-compression failed; fall back to truncating the longer
              // summary so we still have *some* bounded context, and surface
              // the error so a broken backend doesn't silently degrade.
              console.warn(
                "[VA] compressHistory re-compress failed, truncating:",
                err?.message,
              );
              historySummary.current = next.slice(0, SUMMARY_MAX_CHARS);
            });
        }
      })
      .catch((err) => {
        // First compress call failed; history.current was already trimmed
        // above, so the conversation continues without the older context.
        console.warn("[VA] compressHistory failed:", err?.message);
      });
  }

  // ── Pipeline ───────────────────────────────────────────────────────────────

  const processRecording = useCallback(async () => {
    const turnId = ++turnNumber.current;
    console.log(
      "[VA] processRecording entry turn=",
      turnId,
      "isProcessing=",
      isProcessing.current,
    );
    if (isProcessing.current) return;
    isProcessing.current = true;
    const myGen = ++processingGen.current;
    const stale = () => processingGen.current !== myGen;

    const audioUri = await stopRecording();
    console.log("[VA] stopRecording returned", audioUri ? "uri" : "null");
    if (!audioUri) {
      isProcessing.current = false;
      if (isLooping.current) {
        await resumeLoop();
      } else {
        if (mounted.current) setStatusSafe("error", "no-audio-uri");
      }
      return;
    }

    // shouldPlayInBackground=true paired with MEDIA_PLAYBACK in the FGS
    // service types (see services/foreground-service.ts). See matching
    // comment in playSound above — without the FGS type, Android 14+
    // silently rejected the audio session.
    //
    // Wrapped in try/catch: if setAudioModeAsync throws here we still want
    // the turn to proceed (playback may degrade but text path still works);
    // previously a throw aborted the whole turn silently.
    try {
      await setPlaybackSessionActive(true);
      console.log(
        "[VA] audio mode set: playback enabled, shouldPlayInBackground=true",
      );
    } catch (e: any) {
      console.warn("[VA] processRecording setPlaybackSessionActive threw:", e?.message);
    }

    setStatusSafe("processing", "pipeline-start");

    // Per-turn timing bucket. Populated at key events inside this try block
    // and logged once at the end so bottlenecks are visible in one line.
    const turnStartedAt = Date.now();
    const timings: {
      sttMs?: number;
      ttfs?: number; // time to first sentence from turn start
      ttfa?: number; // time to first audio from turn start
    } = {};

    try {
      const sttStart = Date.now();
      const [userText, memoryContext, systemSettings, calendarContext] =
        await Promise.all([
          transcribeAudio(audioUri).then((r) => {
            timings.sttMs = Date.now() - sttStart;
            return r;
          }),
          fetchMemories(),
          fetchSystemSettings(),
          fetchCalendarContext(),
        ]);

      if (stale()) return;

      // Strip wake word prefix — Whisper may transcribe "Hey R3" several ways
      const cleaned = userText
        .replace(
          /^(?:hey\s+(?:r(?:3(?:-?d(?:2)?)?|three)|are\s+three(?:\s+d(?:ew|2)?)?),?\s*)/i,
          "",
        )
        .trim();
      const original = cleaned || userText;

      // Whisper sometimes prepends YouTube-style cruft to a real question.
      // Sentence-level strip recovers the real text when possible; if the
      // remainder isn't usable, fall through to the original drop behavior.
      const stripped = stripHallucinationSentences(original);
      const recovered =
        stripped.trim().split(/\s+/).length >= 2 && !isHallucination(stripped)
          ? stripped
          : null;
      if (recovered && recovered !== original) {
        console.log(
          "[VA] recovered from hallucination strip:",
          JSON.stringify(original),
          "=>",
          JSON.stringify(recovered),
        );
      }
      const finalText = recovered ?? original;

      if (
        finalText.trim().split(/\s+/).length < 2 ||
        isHallucination(finalText)
      ) {
        console.log(
          `[VA] dropped transcription (${isHallucination(finalText) ? "hallucination" : "too-short"}):`,
          JSON.stringify(finalText),
        );
        isProcessing.current = false;
        if (isLooping.current) {
          await resumeLoop();
        } else {
          if (mounted.current) setStatusSafe("idle", "dropped-transcription");
        }
        return;
      }

      const imageSnap = pendingImage;
      if (imageSnap) setPendingImage(null);
      addTurn("user", finalText, imageSnap?.uri);

      // ── System settings ───────────────────────────────────────────────────
      const nameMatch = finalText.match(
        /(?:your name is|call yourself|you are called)\s+(\w+)/i,
      );
      if (nameMatch) {
        await saveSystemSetting("assistant_name", nameMatch[1]);
        return await speakAndFinish(
          `Acknowledged. I'll go by ${nameMatch[1]} from now on.`,
        );
      }

      const addressMatch = finalText.match(
        /(?:address|refer to|call)\s+me\s+as\s+(.+)/i,
      );
      if (addressMatch) {
        const title = addressMatch[1].trim().replace(/[.!]+$/, "");
        await saveSystemSetting("user_address", title);
        return await speakAndFinish(`Understood. I'll address you as ${title}.`);
      }

      const userNameMatch = finalText.match(
        /(?:my name is|call me)\s+([A-Z][a-z]+)/,
      );
      if (userNameMatch) {
        await saveSystemSetting("user_name", userNameMatch[1]);
        return await speakAndFinish(
          `Got it, ${userNameMatch[1]}. I'll remember that.`,
        );
      }

      // ── Voice selection ────────────────────────────────────────────────────
      // Require: (a) a voice name as a whole word, and (b) explicit voice-change intent
      // (the word "voice"/"sound" nearby, or a "switch to X" / "X voice" pattern).
      // Prevents "any sage advice?" or "use this" from spuriously flipping the voice.
      const mentionedVoice = TTS_VOICES.find((v) =>
        new RegExp(`\\b${v}\\b`, "i").test(finalText),
      );
      const voicesAlt = TTS_VOICES.join("|");
      const voiceIntent = new RegExp(
        `\\b(?:${voicesAlt})\\b\\s+(?:voice|sound)\\b` +
          `|\\bswitch\\s+to\\s+(?:the\\s+)?(?:${voicesAlt})\\b` +
          `|\\b(?:change|set)\\s+(?:the\\s+|your\\s+|my\\s+)?(?:voice|sound)\\s+to\\s+(?:${voicesAlt})\\b` +
          `|\\buse\\s+(?:the\\s+)?(?:${voicesAlt})(?:'s)?\\s+(?:voice|sound)\\b`,
        "i",
      );
      if (mentionedVoice && voiceIntent.test(finalText)) {
        const idx = TTS_VOICES.indexOf(mentionedVoice);
        voiceIndex.current = idx;
        return await speakAndFinish(`Switched to ${mentionedVoice}.`, mentionedVoice);
      }

      // ── Volume control ────────────────────────────────────────────────────
      const volUpMatch =
        /\b(?:louder|volume up|speak up|turn(?:ing)? up|increase volume|more volume)\b/i.test(
          finalText,
        );
      const volDownMatch =
        /\b(?:quieter|softer|volume down|turn(?:ing)? (?:it )?down|lower(?: the)? volume|decrease volume|less volume)\b/i.test(
          finalText,
        );
      const volSetMatch = finalText.match(/\bvolume\s+(?:to\s+)?(\d+)\b/i);
      if (volUpMatch || volDownMatch || volSetMatch) {
        if (volSetMatch) {
          volumeLevel.current = Math.min(
            1,
            Math.max(0.1, parseInt(volSetMatch[1]) / 10),
          );
        } else if (volUpMatch) {
          volumeLevel.current = Math.min(1.0, volumeLevel.current + 0.2);
        } else {
          volumeLevel.current = Math.max(0.1, volumeLevel.current - 0.2);
        }
        const pct = Math.round(volumeLevel.current * 10);
        return await speakAndFinish(`Volume set to ${pct}.`);
      }

      // ── Personality tuning ────────────────────────────────────────────────
      const personalityMatch = finalText.match(/\bbe\s+(?:more\s+)?(\w+)/i);
      const PERSONALITIES: Record<string, string> = {
        casual: "casual",
        informal: "casual",
        relaxed: "casual",
        chill: "casual",
        formal: "formal",
        professional: "formal",
        serious: "formal",
        brief: "brief",
        concise: "brief",
        short: "brief",
        quick: "brief",
        detailed: "detailed",
        verbose: "detailed",
        thorough: "detailed",
        friendly: "friendly",
        warm: "friendly",
        kind: "friendly",
        direct: "direct",
        blunt: "direct",
        sharp: "direct",
      };
      if (personalityMatch) {
        const trait = PERSONALITIES[personalityMatch[1].toLowerCase()];
        if (trait) {
          await saveSystemSetting("personality", trait);
          return await speakAndFinish(`Adjusted. Switching to ${trait} mode.`);
        }
      }

      // ── Voice-commanded saves ─────────────────────────────────────────────
      const saveMatch = parseSaveCommand(finalText);
      if (saveMatch) {
        try {
          await saveEntry(saveMatch[0], saveMatch[1].trim());
        } catch {
          if (mounted.current) {
            setError("Something went off course. Check your connection.");
            setStatusSafe("error", "saveEntry-failed");
          }
          isProcessing.current = false;
          return;
        }
        const replies: Record<string, string> = {
          note: "Acknowledged. Logged and secured.",
          todo: "Task received. Adding it to the manifest.",
          decision: "Decision locked in. We'll proceed accordingly.",
          summary: "Summary received. Stored and ready for deployment.",
        };
        return await speakAndFinish(replies[saveMatch[0]] ?? "Handled.");
      }

      // ── Gmail read (via Apps Script proxy) ──────────────────────────────
      if (isGmailReadCommand(finalText)) {
        const unread = isUnreadVariant(finalText);
        const scopedLabel = detectGmailAccountLabel(finalText);
        const emails = unread
          ? await fetchUnreadEmails(5, scopedLabel)
          : await fetchRecentEmails(5, scopedLabel);
        if (stale()) { isProcessing.current = false; return; }
        if (emails.length === 0) {
          const where = scopedLabel ? ` in ${scopedLabel}` : "";
          return await speakAndFinish(
            unread
              ? `Inbox is clear${where}. No unread messages.`
              : `No recent messages found${where}.`,
          );
        }
        // Stash the top email so "reply to that email" has a referent.
        // 5-min TTL — long enough for a natural follow-up, short enough that
        // a later reply won't silently attach to a stale thread.
        const top = emails[0];
        lastDiscussedEmail.current = {
          threadId: top.id,
          from: top.from,
          subject: top.subject,
          account: top.account,
          expiresAt: Date.now() + LAST_EMAIL_TTL_MS,
        };
        const summary = await summarizeEmailsForVoice(emails, unread);
        if (stale()) { isProcessing.current = false; return; }
        return await speakAndFinish(summary);
      }

      // ── Google OAuth: sign in / sign out ────────────────────────────────
      if (isGoogleSignInCommand(finalText)) {
        if (await isGoogleSignedIn()) {
          return await speakAndFinish("You're already connected to Google.");
        }
        // Stop the listen loop while the browser is in focus; onConnected will speak confirmation.
        isLooping.current = false;
        setLooping(false);
        await speakAndFinish("Opening Google sign-in in your browser.");
        promptGoogleSignIn();
        return;
      }

      if (isGoogleSignOutCommand(finalText)) {
        await clearGoogleTokens();
        return await speakAndFinish("Google account disconnected.");
      }

      // ── Calendar: confirm a pending event from the prior turn ────────────
      // Runs BEFORE the calendar-command detector so that a bare "yes"/"no"
      // after a proposal goes to the right branch. Expired or ambiguous input
      // clears the pending and falls through to normal processing.
      {
        const pending = pendingCalendarEvent.current;
        if (pending) {
          if (Date.now() > pending.expiresAt) {
            pendingCalendarEvent.current = null;
            console.log("[VA] pending calendar expired — falling through");
          } else {
            const conf = detectConfirmation(finalText);
            if (conf === "yes") {
              pendingCalendarEvent.current = null;
              const result = await createCalendarEvent({
                title: pending.title,
                startDate: pending.startDate,
                endDate: pending.endDate,
                allDay: pending.allDay,
                location: pending.location,
              });
              if (stale()) { isProcessing.current = false; return; }
              if (!result.ok) {
                const msg =
                  result.reason === "permission"
                    ? `I don't have calendar access. Grant it in app permissions.`
                    : result.reason === "no_calendar"
                      ? `No writable calendar found on this device.`
                      : `Couldn't save that event. ${result.message}`;
                return await speakAndFinish(msg);
              }
              return await speakAndFinish(
                formatEventConfirmation(
                  pending.title,
                  pending.startDate,
                  !!pending.allDay,
                ),
              );
            }
            if (conf === "no") {
              pendingCalendarEvent.current = null;
              return await speakAndFinish(`Okay, skipped.`);
            }
            // Ambiguous — drop the pending and fall through. Don't wedge the
            // conversation waiting for a clean yes/no.
            pendingCalendarEvent.current = null;
            console.log("[VA] pending calendar dropped — non-confirmation input");
          }
        }
      }

      // ── Calendar event creation (two-turn: summarize, then confirm) ──────
      if (isCalendarCommand(finalText)) {
        const parsed = await parseEventFromSpeech(finalText);
        if (stale()) { isProcessing.current = false; return; }
        if (!parsed) {
          return await speakAndFinish(
            `I couldn't nail down the time. Try "tomorrow at 1 PM" or "Friday 3 to 4 PM".`,
          );
        }
        // Preflight permission/writable-calendar check before asking the user
        // to confirm an event we couldn't save anyway. Prompts for Android
        // calendar permission here on first use, same as today — just earlier.
        const avail = await ensureCalendarWritable();
        if (stale()) { isProcessing.current = false; return; }
        if (!avail.ok) {
          return await speakAndFinish(
            avail.reason === "permission"
              ? `I don't have calendar access. Grant it in app permissions.`
              : `No writable calendar found on this device.`,
          );
        }
        const startDate = new Date(parsed.startISO);
        const endDate = new Date(parsed.endISO);
        pendingCalendarEvent.current = {
          title: parsed.title,
          startDate,
          endDate,
          allDay: parsed.allDay,
          location: parsed.location,
          expiresAt: Date.now() + PENDING_CAL_TTL_MS,
        };
        const proposal = formatEventProposal(
          parsed.title,
          startDate,
          endDate,
          !!parsed.allDay,
          parsed.location,
        );
        return await speakAndFinish(`${proposal}. Should I create it?`);
      }

      // ── Tasks (create / list / complete) ─────────────────────────────────
      const taskCmd = detectTaskCommand(finalText);
      if (taskCmd) {
        try {
          if (taskCmd.kind === "add") {
            const row = await createTask(taskCmd.title, { source: "voice" });
            if (stale()) { isProcessing.current = false; return; }
            return await speakAndFinish(
              row
                ? `Task logged: ${row.title}.`
                : `Couldn't save that task. Check your connection.`,
            );
          }
          if (taskCmd.kind === "list") {
            const rows = await listOpenTasks(10);
            if (stale()) { isProcessing.current = false; return; }
            if (rows.length === 0) {
              return await speakAndFinish(`Manifest is clear. No open tasks.`);
            }
            const titles = rows.map((r) => r.title).join("; ");
            const count = rows.length === 1 ? "One task" : `${rows.length} tasks`;
            return await speakAndFinish(`${count} open: ${titles}.`);
          }
          if (taskCmd.kind === "done") {
            const row = await completeTaskByTitle(taskCmd.titleFragment);
            if (stale()) { isProcessing.current = false; return; }
            return await speakAndFinish(
              row
                ? `Marked complete: ${row.title}.`
                : `No open task matching "${taskCmd.titleFragment}".`,
            );
          }
        } catch (e: any) {
          console.warn("[tasks] command failed:", e?.message);
          if (mounted.current) {
            setError("Task backend is offline. Try again shortly.");
            setStatusSafe("error", "tasks-failed");
          }
          isProcessing.current = false;
          return;
        }
      }

      // ── Reminders (create / list) ────────────────────────────────────────
      const reminderCmd = detectReminderCommand(finalText);
      if (reminderCmd) {
        try {
          if (reminderCmd.kind === "create") {
            const when = parseReminderTime(reminderCmd.timeSpec);
            if (!when) {
              return await speakAndFinish(
                `I couldn't make sense of "${reminderCmd.timeSpec}". Try "at 3pm", "in 30 minutes", or "tomorrow at 9am".`,
              );
            }
            const row = await createReminder(reminderCmd.title, when);
            if (stale()) { isProcessing.current = false; return; }
            return await speakAndFinish(
              row
                ? `Reminder set for ${formatReminderTime(when)}: ${row.title}.`
                : `Couldn't save that reminder. Check your connection.`,
            );
          }
          if (reminderCmd.kind === "list") {
            const rows = await listTodayReminders();
            if (stale()) { isProcessing.current = false; return; }
            if (rows.length === 0) {
              return await speakAndFinish(`Nothing on the reminder list today.`);
            }
            const parts = rows.map(
              (r) => `${formatReminderTime(new Date(r.remind_at))}: ${r.title}`,
            );
            const count = rows.length === 1 ? `One reminder today` : `${rows.length} reminders today`;
            return await speakAndFinish(`${count}. ${parts.join(". ")}.`);
          }
        } catch (e: any) {
          console.warn("[reminders] command failed:", e?.message);
          if (mounted.current) {
            setError("Reminder backend is offline. Try again shortly.");
            setStatusSafe("error", "reminders-failed");
          }
          isProcessing.current = false;
          return;
        }
      }

      // ── Email: confirm a pending draft/reply from the prior turn ─────────
      // Same pattern as the calendar pending-check. Runs BEFORE detectEmailCommand
      // so a bare "yes"/"no" after a read-back is dispatched correctly.
      {
        const pending = pendingEmail.current;
        if (pending) {
          if (Date.now() > pending.expiresAt) {
            pendingEmail.current = null;
            console.log("[VA] pending email expired — falling through");
          } else {
            const conf = detectConfirmation(finalText);
            if (conf === "yes") {
              pendingEmail.current = null;
              try {
                const result =
                  pending.kind === "draft"
                    ? await sendEmail(pending.to, pending.subject, pending.body, pending.account)
                    : await replyToThread(pending.threadId, pending.body, pending.account);
                if (stale()) { isProcessing.current = false; return; }
                if (!result.ok) {
                  return await speakAndFinish(
                    `Couldn't send that. ${result.error}.`,
                  );
                }
                return await speakAndFinish(
                  pending.kind === "draft"
                    ? `Sent to ${pending.to}.`
                    : `Reply sent.`,
                );
              } catch (e: any) {
                console.warn("[email] send failed:", e?.message);
                return await speakAndFinish(`Send failed. Try again.`);
              }
            }
            if (conf === "no") {
              pendingEmail.current = null;
              return await speakAndFinish(`Okay, discarded.`);
            }
            pendingEmail.current = null;
            console.log("[VA] pending email dropped — non-confirmation input");
          }
        }
      }

      // ── Email (two-turn: draft, read back, then confirm) ─────────────────
      const emailCmd = detectEmailCommand(finalText);
      if (emailCmd) {
        if (emailCmd.kind === "draft") {
          const to = normalizeSpokenAddress(emailCmd.to);
          if (!to) {
            return await speakAndFinish(
              `I need a full email address — say it like "luke at gmail dot com".`,
            );
          }
          const body = emailCmd.message;
          // Structured form ("... Subject: ... Body: ...") dictates subject;
          // legacy "saying" form falls back to deriving from the body.
          const subject = emailCmd.subject?.trim() || deriveSubject(body);
          pendingEmail.current = {
            kind: "draft",
            to,
            subject,
            body,
            account: undefined, // primary account
            expiresAt: Date.now() + PENDING_EMAIL_TTL_MS,
          };
          return await speakAndFinish(
            `Drafted to ${to}, subject "${subject}". Body: ${body}. Send it?`,
          );
        }
        // kind === "reply"
        const target = lastDiscussedEmail.current;
        if (!target || Date.now() > target.expiresAt) {
          lastDiscussedEmail.current = null;
          return await speakAndFinish(
            `I don't have an email in focus. Check your inbox first, then tell me what to say.`,
          );
        }
        pendingEmail.current = {
          kind: "reply",
          threadId: target.threadId,
          replyingTo: target.from,
          body: emailCmd.message,
          account: target.account,
          expiresAt: Date.now() + PENDING_EMAIL_TTL_MS,
        };
        return await speakAndFinish(
          `Replying to ${target.from} with: ${emailCmd.message}. Send it?`,
        );
      }

      // ── Daily synthesis (briefing: calendar + email + tasks + reminders) ─
      // Hard-wired orchestration, not the general GPT flow. One shaped call.
      if (detectSynthesisCommand(finalText)) {
        try {
          const briefing = await runDailySynthesis();
          if (stale()) { isProcessing.current = false; return; }
          if (!briefing) {
            return await speakAndFinish(
              `Nothing material today. Context was thin across the board.`,
            );
          }
          return await speakAndFinish(briefing);
        } catch (e: any) {
          console.warn("[synthesis] failed:", e?.message);
          if (mounted.current) {
            setError("Briefing failed. Try again shortly.");
          }
          isProcessing.current = false;
          return;
        }
      }

      // ── Normal GPT flow ───────────────────────────────────────────────────
      streamAbort.current?.abort();
      streamAbort.current = new AbortController();

      const ttsQueue: Promise<string>[] = [];
      let streamDone = false;
      let pendingSentence = "";
      // Guards against double-adding the assistant turn. The stream's .then()
      // publishes text to the UI as soon as it resolves; the post-drain path
      // is the fallback for stream-errored turns where .then() didn't fire.
      let textPublished = false;
      // First chunk fires sooner to minimize time-to-first-audio. Subsequent
      // chunks batch at the larger threshold so continuous playback stays
      // smooth (short chunks create audible choppiness).
      const MIN_TTS_WORDS_FIRST = 3;
      const MIN_TTS_WORDS_REST = 6;
      // 3 concurrent fetches keeps chunk N+2 ready before chunk N+1 finishes,
      // closing the audible gap between chunks on long replies.
      const MAX_TTS_INFLIGHT = 3;
      let ttsInflight = 0;
      const ttsWaiters: Array<() => void> = [];
      const acquireTtsSlot = async () => {
        if (ttsInflight < MAX_TTS_INFLIGHT) {
          ttsInflight++;
          return;
        }
        await new Promise<void>((r) => ttsWaiters.push(r));
        ttsInflight++;
      };
      const releaseTtsSlot = () => {
        ttsInflight--;
        const next = ttsWaiters.shift();
        if (next) next();
      };

      const pushTts = (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const alphaRatio =
          (trimmed.match(/[a-zA-Z]/g)?.length ?? 0) / trimmed.length;
        if (alphaRatio < 0.4) return;
        const idx = ttsQueue.length;
        const t0 = Date.now();
        console.log(
          `[BG-AUDIO TTS turn=${turnId} idx=${idx}] queued words=${trimmed.split(/\s+/).length} appState=${AppState.currentState}`,
        );
        const gated = (async () => {
          await acquireTtsSlot();
          try {
            console.log(
              `[BG-AUDIO TTS turn=${turnId} idx=${idx}] fetch start (waited ${Date.now() - t0}ms) appState=${AppState.currentState}`,
            );
            const uri = await synthesizeSpeech(
              trimmed,
              `tts-${myGen}-${idx}.mp3`,
              currentVoice(),
            );
            console.log(
              `[BG-AUDIO TTS turn=${turnId} idx=${idx}] fetch done in ${Date.now() - t0}ms appState=${AppState.currentState}`,
            );
            bumpProgress();
            return uri;
          } catch (err: any) {
            console.warn(
              `[BG-AUDIO TTS turn=${turnId} idx=${idx}] FAILED in ${Date.now() - t0}ms appState=${AppState.currentState}:`,
              err?.message,
            );
            throw err;
          } finally {
            releaseTtsSlot();
          }
        })();
        ttsQueue.push(gated);
      };

      // Fire streaming without awaiting — play loop runs concurrently
      const fullContext = [memoryContext, calendarContext]
        .filter(Boolean)
        .join("\n\n");
      const streamPromise = streamChatResponse(
        buildHistorySlice(imageSnap, finalText),
        fullContext,
        (sentence) => {
          if (timings.ttfs == null) timings.ttfs = Date.now() - turnStartedAt;
          bumpProgress();
          const combined =
            (pendingSentence ? pendingSentence + " " : "") + sentence.trim();
          const words = combined.split(/\s+/);
          const threshold =
            ttsQueue.length === 0 ? MIN_TTS_WORDS_FIRST : MIN_TTS_WORDS_REST;
          if (words.length < threshold) {
            pendingSentence = combined;
            return;
          }
          pendingSentence = "";
          pushTts(combined);
        },
        streamAbort.current.signal,
        systemSettings,
      )
        .then((text) => {
          streamDone = true;
          if (pendingSentence) {
            pushTts(pendingSentence);
            pendingSentence = "";
          }
          // Publish text to the UI as soon as the stream resolves, without
          // waiting for the audio drain. Backgrounded, failed chunks take
          // ~4s each (watchdog + retry) before throwing; waiting for drain
          // stretches visible-text latency by many seconds even when the
          // stream itself arrived promptly.
          if (
            mounted.current &&
            processingGen.current === myGen &&
            text &&
            !textPublished
          ) {
            textPublished = true;
            addTurn("assistant", text);
          }
          return text;
        })
        .catch((err) => {
          streamDone = true;
          throw err;
        });

      // Swallow a late rejection if the turn was already abandoned (stale).
      // The await at end-of-drain still throws on the live path; this only
      // silences "unhandled promise rejection" noise on aborted turns.
      streamPromise.catch((err) => {
        if (processingGen.current !== myGen) {
          console.warn(
            "[VA] streamPromise rejected post-stale, swallowed:",
            err?.message,
          );
        }
      });

      if (mounted.current) setStatusSafe("speaking", "stream-ready");

      // Drain the TTS queue as sentences arrive, without waiting for streaming to finish.
      // Per-chunk failures (fetch reject, body timeout, or playback throw) are isolated
      // so one bad chunk doesn't abort the whole reply. Previously a single rejected
      // ttsQueue item surfaced to the outer catch and reduced the turn to a recovery
      // line — this is the "text-only response" symptom.
      let playIdx = 0;
      let chunkFailures = 0;
      while (true) {
        if (stale()) {
          isProcessing.current = false;
          return;
        }
        if (playIdx < ttsQueue.length) {
          let uri: string | null = null;
          try {
            uri = await ttsQueue[playIdx];
          } catch (err: any) {
            chunkFailures++;
            console.warn(
              `[TTS turn=${turnId} idx=${playIdx}] fetch rejected, skipping:`,
              err?.message,
            );
          }
          if (stale()) {
            isProcessing.current = false;
            return;
          }
          if (uri) {
            if (timings.ttfa == null) timings.ttfa = Date.now() - turnStartedAt;
            console.log(
              `[BG-AUDIO PLAY turn=${turnId} idx=${playIdx}] start appState=${AppState.currentState}`,
            );
            bumpProgress();
            const p0 = Date.now();
            try {
              await playSound(uri);
              console.log(
                `[BG-AUDIO PLAY turn=${turnId} idx=${playIdx}] done in ${Date.now() - p0}ms appState=${AppState.currentState}`,
              );
            } catch (err: any) {
              chunkFailures++;
              console.warn(
                `[BG-AUDIO PLAY turn=${turnId} idx=${playIdx}] threw appState=${AppState.currentState}:`,
                err?.message,
              );
            }
            bumpProgress();
          }
          playIdx++;
          if (streamDone && playIdx === ttsQueue.length) {
            console.log(
              `[TTS turn=${turnId}] final chunk played idx=${playIdx - 1}`,
            );
          }
        } else if (streamDone) {
          console.log(
            `[TTS turn=${turnId}] drain complete played=${playIdx} queued=${ttsQueue.length} failures=${chunkFailures}`,
          );
          break;
        } else {
          await new Promise<void>((r) => setTimeout(r, 50));
        }
      }

      // Full-reply fallback: if every per-sentence TTS failed (fetch reject,
      // body timeout, or playback throw) but the chat stream itself completed,
      // try once more with the full assistant text as a single request. This
      // rescues turns that would otherwise end in silence after the user has
      // already seen the "speaking" status.
      if (
        chunkFailures > 0 &&
        chunkFailures === playIdx &&
        !stale()
      ) {
        try {
          const fullReply = await streamPromise;
          if (fullReply && !stale()) {
            console.log(
              `[TTS turn=${turnId}] all ${chunkFailures} chunks failed — attempting full-reply fallback`,
            );
            const fbUri = await synthesizeSpeech(
              fullReply,
              `tts-${myGen}-fallback.mp3`,
              currentVoice(),
            );
            if (!stale()) {
              bumpProgress();
              await playSound(fbUri);
              bumpProgress();
              console.log(`[TTS turn=${turnId}] fallback playback complete`);
            }
          }
        } catch (err: any) {
          console.warn(
            `[TTS turn=${turnId}] full-reply fallback failed:`,
            err?.message,
          );
        }
      }

      // Fire-and-forget: setAudioModeAsync takes 100–300ms and we're about to
      // hand audio session back to the native recorder anyway, which owns its
      // own session. Awaiting this was pure dead air before resumeLoop.
      releasePlaybackAudio().catch((e: any) =>
        console.warn(
          "[VA] releasePlaybackAudio async failed (post-drain):",
          e?.message,
        ),
      );

      if (stale()) {
        console.log(
          `[VA turn=${turnId}] stale after drain — still attempting resume`,
        );
        isProcessing.current = false;
        await finishTurnToListening("post-drain-stale");
        return;
      }
      const assistantText = await streamPromise; // already resolved

      if (mounted.current && assistantText && !textPublished) {
        textPublished = true;
        addTurn("assistant", assistantText);
      }

      if (stale()) {
        console.log(
          `[VA turn=${turnId}] stale after streamPromise — still attempting resume`,
        );
        isProcessing.current = false;
        await finishTurnToListening("post-stream-stale");
        return;
      }
      // Fire-and-forget memory write; surface failures so a broken backend
      // doesn't degrade silently (was: no .catch — unhandled rejection).
      void extractAndSaveMemory(finalText, assistantText).catch((err) =>
        console.warn("[memory] extractAndSaveMemory failed:", err?.message),
      );
      turnsSinceCompress.current += 1;
      if (turnsSinceCompress.current >= 6) {
        turnsSinceCompress.current = 0;
        compressHistory();
      }
      // Short settle lets Android release the audio focus playSound held
      // before the recorder re-grabs it. 200ms is plenty; the old 800ms was
      // the dominant source of end-of-turn dead air.
      await new Promise<void>((r) => setTimeout(r, 200));
      console.log(
        `[VA TIMING turn=${turnId}] STT=${timings.sttMs ?? "?"}ms ` +
          `TTFS=${timings.ttfs ?? "?"}ms ` +
          `TTFA=${timings.ttfa ?? "?"}ms ` +
          `total=${Date.now() - turnStartedAt}ms`,
      );
      console.log(
        "[VA] post-TTS, about to resumeLoop, isLooping=",
        isLooping.current,
      );
      await finishTurnToListening(`turn-${turnId}-end`);
      isProcessing.current = false;
      console.log("[VA] processRecording end, isProcessing reset");
    } catch (err: any) {
      if (err?.name === "AbortError") {
        isProcessing.current = false;
        return;
      }
      console.error("[useVoiceAssistant]", err);
      isProcessing.current = false;
      if (!mounted.current) return;

      const msg = (err?.message ?? "").toLowerCase();
      const recoveryLine =
        msg.includes("network") || msg.includes("fetch")
          ? "Lost the signal. Check your connection."
          : msg.includes("timeout")
            ? "That took too long. Say it again."
            : msg.includes("whisper") || msg.includes("transcri")
              ? "Missed that. Say it again."
              : "Something went sideways. Standing by.";

      try {
        await speakAndFinish(recoveryLine);
      } catch {
        setError(recoveryLine);
        setStatusSafe("error", "catch-fallback");
      }
      // Guarantee the mic attempts to come back up even if speakAndFinish's
      // own resume failed or the catch-fallback branch ran.
      await finishTurnToListening("outer-catch-end");
    } finally {
      // Safety net: stale() early returns inside the try block above don't
      // explicitly reset isProcessing, and a future edit could miss one too.
      // Without this, a leaked flag blocks every subsequent turn at the
      // entry guard (`if (isProcessing.current) return`). Logged when it
      // actually trips so we can spot the leaking path.
      if (isProcessing.current) {
        console.warn(
          "[VA] processRecording finally: isProcessing was still true (turn=" +
            turnId + "), safety reset",
        );
        isProcessing.current = false;
      }
    }
  }, [stopRecording, startRecording]);

  // ── Silence detection ──────────────────────────────────────────────────────
  // Event-driven off the native AudioStreamModule. Does NOT depend on React
  // state or re-renders, so it continues to run while the activity is
  // backgrounded (FGS keeps the JS thread alive).

  const processRecordingRef = useRef<() => void>(() => {});
  useEffect(() => {
    processRecordingRef.current = () => {
      void processRecording();
    };
  }, [processRecording]);

  useEffect(() => {
    const unsub = onAudioFrame((frame) => {
      if (!isRecordingRef.current) return;
      if (statusRef.current !== "listening") return;
      if (Date.now() - recordingStartedAt.current < POST_RESTART_GRACE_MS)
        return;

      const db = frame.dbfs;
      const threshold = ambientDb.current + SPEECH_MARGIN_DB;

      if (db > threshold) {
        speechSamples.current += 1;
        if (
          speechSamples.current >= SPEECH_CONFIRM_SAMPLES &&
          !hasSpoken.current
        ) {
          hasSpoken.current = true;
          speechStart.current = Date.now();
          console.log(
            "[VA] speech armed db=",
            db.toFixed(1),
            "ambient=",
            ambientDb.current.toFixed(1),
          );
        }
        silenceStart.current = null;
      } else {
        if (!hasSpoken.current) {
          const next =
            ambientDb.current * (1 - AMBIENT_ALPHA) + db * AMBIENT_ALPHA;
          ambientDb.current = Math.max(-60, Math.min(-30, next));
        }

        if (hasSpoken.current) {
          speechSamples.current = 0;
          if (silenceStart.current === null) {
            silenceStart.current = Date.now();
          } else if (
            Date.now() - silenceStart.current >= SILENCE_DURATION_MS
          ) {
            const spokenDuration = speechStart.current
              ? Date.now() - speechStart.current
              : 0;
            hasSpoken.current = false;
            speechStart.current = null;
            silenceStart.current = null;
            if (spokenDuration >= MIN_SPEECH_DURATION_MS) {
              processRecordingRef.current();
            }
          }
        }
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!isRecording) {
      hasSpoken.current = false;
      speechSamples.current = 0;
      speechStart.current = null;
      silenceStart.current = null;
      ambientDb.current = -42;
      console.log("[VA] reset detection state, ambient=-42");
    } else {
      recordingStartedAt.current = Date.now();
    }
  }, [isRecording]);

  // Progress-based watchdog: trip only if no activity (stream token, TTS fetch done,
  // playback started/finished) within WATCHDOG_MS. Long replies are safe as long as
  // *something* is making forward progress.
  const WATCHDOG_MS = 20_000;
  useEffect(() => {
    // Also run in 'listening' so a leaked isProcessing (stuck-true while UI
    // says listening) can still be detected and reset. Without this branch,
    // a leak would silently block all subsequent turns until the user taps.
    // The interval re-checks isProcessing on every tick, so a leak that
    // appears *after* entering listening is still caught.
    if (
      status !== "processing" &&
      status !== "speaking" &&
      status !== "listening"
    )
      return;
    bumpProgress();
    const interval = setInterval(() => {
      // In 'listening', only trip when a leak is actually present —
      // otherwise normal idle listening would constantly trip the watchdog.
      if (status === "listening" && !isProcessing.current) {
        bumpProgress();
        return;
      }
      if (Date.now() - lastProgressAt.current >= WATCHDOG_MS) {
        console.warn(
          "[VA] watchdog tripped in status=",
          status,
          "isProcessing=",
          isProcessing.current,
          "— no progress for",
          WATCHDOG_MS,
          "ms",
        );
        clearInterval(interval);
        interrupt();
        if (isLooping.current) {
          resumeLoop();
        } else if (mounted.current) setStatusSafe("idle", "watchdog");
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [status]);

  // ── Button handler ─────────────────────────────────────────────────────────

  const handlePress = useCallback(async () => {
    console.log(
      "[VA] handlePress entry status=", status,
      "looping=", looping,
      "isLooping=", isLooping.current,
    );
    if (status === "speaking" || status === "processing") {
      console.log("[VA] handlePress branch: interrupt-and-resume");
      // Interrupt mid-response and jump straight back to listening
      interrupt();
      if (isLooping.current) {
        await resumeLoop();
      } else {
        if (mounted.current) setStatusSafe("idle", "press:interrupt");
      }
    } else if (looping) {
      console.log("[VA] handlePress branch: stop-loop");
      // Stop the loop entirely
      isLooping.current = false;
      setLooping(false);
      interrupt();
      setError(null);
      setStatusSafe("idle", "press:stop");
      stopForegroundService();
    } else if (status === "idle" || status === "error") {
      console.log("[VA] handlePress branch: start-loop");
      setError(null);
      await startForegroundService();
      const ok = await ensureListeningLockedRef.current("press");
      if (!ok) {
        stopForegroundService();
        setError(
          "Microphone access denied. Enable it in Android Settings → Apps → R3-D2 → Permissions.",
        );
        setStatusSafe("error", "press:mic-denied");
      }
    }
  }, [status, looping, startRecording]);

  // Assist-gesture bridge: Android VoiceInteractionSession launches us with r3d2://assist.
  // Always ensure the loop is listening — never toggle off an active session.
  const ensureListeningRef = useRef<() => void>(() => {});
  ensureListeningRef.current = () => {
    const s = statusRef.current;
    console.log(
      "[VA] ensureListening entry status=", s,
      "isLooping=", isLooping.current,
      "isRecording=", isRecordingRef.current,
    );
    if (s === "speaking" && isLooping.current && currentSound.current) {
      console.log("[VA] ensureListening branch: active playback in progress — ignore assist re-entry");
      return;
    }
    if (s === "speaking" || s === "processing") {
      console.log("[VA] ensureListening branch: interrupt+resume");
      interrupt();
      if (isLooping.current) {
        void resumeLoopRef.current();
        return;
      }
    } else if (s === "listening") {
      console.log("[VA] ensureListening branch: already listening — no-op");
      return;
    }
    const needsStart = !isLooping.current;
    console.log("[VA] ensureListening branch: start (needsStart=", needsStart, ")");
    if (needsStart) setError(null);
    void (async () => {
      if (needsStart) await startForegroundService();
      const ok = await ensureListeningLockedRef.current("assist");
      if (!mounted.current) return;
      if (!ok) {
        // Gate already unrolled isLooping; assist surfaces failure as error.
        setStatusSafe("error", "assist:fail");
      }
    })();
  };

  useEffect(() => {
    const onUrl = (url: string | null | undefined) => {
      console.log("[VA] Linking URL received:", url);
      if (url && /assist/i.test(url)) ensureListeningRef.current();
    };
    Linking.getInitialURL().then(onUrl).catch(() => {});
    const urlSub = Linking.addEventListener("url", (e) => onUrl(e.url));
    // Native AssistInteractionSession emits this when R2 is already running
    // so it can respond to the assist gesture without popping to the front.
    const assistSub = DeviceEventEmitter.addListener("r2Assist", () => {
      console.log("[VA] r2Assist bridge event received");
      ensureListeningRef.current();
    });
    return () => {
      urlSub.remove();
      assistSub.remove();
    };
  }, []);

  return {
    status,
    transcript,
    error,
    looping,
    handlePress,
    pendingImage,
    setPendingImage,
    sendText,
  };
}

