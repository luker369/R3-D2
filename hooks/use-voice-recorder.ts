/**
 * hooks/use-voice-recorder.ts
 *
 * Manages microphone recording via expo-audio.
 * Metering is enabled so the caller can detect silence and auto-stop.
 *
 * useAudioRecorderState polls the recorder every METERING_INTERVAL_MS and
 * exposes the current dB level as `metering`. The caller (use-voice-assistant)
 * watches this value and stops recording after sustained silence.
 */

import {
    AudioModule,
    RecordingPresets,
    setAudioModeAsync,
    useAudioRecorder,
    useAudioRecorderState,
} from "expo-audio";
import { useCallback, useRef, useState } from "react";

const METERING_INTERVAL_MS = 100; // poll 10× per second
const NATIVE_CALL_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`[useVoiceRecorder] ${label} timed out after ${ms}ms`),
          ),
        ms,
      ),
    ),
  ]);
}

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);
  const hasBeenUsed = useRef(false);

  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });

  const recorderState = useAudioRecorderState(recorder, METERING_INTERVAL_MS);

  const startRecording = useCallback(async (): Promise<boolean> => {
    console.log(
      "[REC] startRecording called, alreadyRecording=",
      isRecordingRef.current,
      "hasBeenUsed=",
      hasBeenUsed.current,
    );
    if (isRecordingRef.current) return true;

    const { granted } = await AudioModule.requestRecordingPermissionsAsync();
    if (!granted) {
      console.warn("[useVoiceRecorder] Microphone permission denied.");
      return false;
    }

    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: "duckOthers",
        shouldRouteThroughEarpiece: false,
        /** Keeps session usable when switching apps (esp. with Android FGS in dev builds). */
        shouldPlayInBackground: true,
        allowsBackgroundRecording: true,
      });

      if (hasBeenUsed.current) {
        await new Promise<void>((r) => setTimeout(r, 600));
      }

      try {
        await withTimeout(
          recorder.prepareToRecordAsync(),
          NATIVE_CALL_TIMEOUT_MS,
          "prepare",
        );
      } catch (prepareErr) {
        console.warn(
          "[useVoiceRecorder] prepare failed, retrying:",
          prepareErr,
        );
        await new Promise<void>((r) => setTimeout(r, 500));
        await withTimeout(
          recorder.prepareToRecordAsync(),
          NATIVE_CALL_TIMEOUT_MS,
          "prepare-retry",
        );
      }
      recorder.record();
      hasBeenUsed.current = true;
      console.log("[REC] recorder.record() called, success");
    } catch (e) {
      console.warn("[useVoiceRecorder] Failed to start recording:", e);
      return false;
    }

    isRecordingRef.current = true;
    setIsRecording(true);
    return true;
  }, [recorder]);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (!isRecordingRef.current) return null;
    isRecordingRef.current = false;
    setIsRecording(false);

    try {
      await withTimeout(recorder.stop(), NATIVE_CALL_TIMEOUT_MS, "stop");
    } catch (e) {
      console.warn("[useVoiceRecorder] stop() failed:", e);
      return null;
    }

    const uri = recorder.uri;
    if (!uri) {
      console.warn("[useVoiceRecorder] No URI after stop.");
      return null;
    }

    return uri;
  }, [recorder]);

  return {
    startRecording,
    stopRecording,
    isRecording,
    metering: recorderState.metering, // dB level, undefined when not recording
  };
}
