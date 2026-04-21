/**
 * hooks/use-voice-recorder.ts
 *
 * Microphone recording via the native AudioStreamModule. Mic capture is
 * owned by a native thread (not expo-audio / not React), so it continues
 * while the activity is backgrounded. Per-frame dBFS is delivered via
 * DeviceEventEmitter events, not React state — consumers subscribe via
 * `onAudioFrame` from `services/audio-stream`.
 */

import * as FileSystem from "expo-file-system/legacy";
import { useCallback, useRef, useState } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import {
  startAudioStream,
  stopAudioStream,
} from "@/services/audio-stream";

async function ensureMicPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const granted = await PermissionsAndroid.check(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  );
  if (granted) return true;
  const res = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  );
  return res === PermissionsAndroid.RESULTS.GRANTED;
}

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);

  const startRecording = useCallback(async (): Promise<boolean> => {
    console.log("[REC] startRecording called, alreadyRecording=", isRecordingRef.current);
    if (isRecordingRef.current) return true;

    const ok = await ensureMicPermission();
    if (!ok) {
      console.warn("[REC] RECORD_AUDIO permission denied");
      return false;
    }

    const uri = `${FileSystem.cacheDirectory}r2-rec-${Date.now()}.wav`;
    const started = await startAudioStream(uri);
    if (!started) {
      console.warn("[REC] native startAudioStream returned false");
      return false;
    }

    isRecordingRef.current = true;
    setIsRecording(true);
    console.log("[REC] native capture started uri=", uri);
    return true;
  }, []);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (!isRecordingRef.current) return null;
    isRecordingRef.current = false;
    setIsRecording(false);

    const uri = await stopAudioStream();
    if (!uri) {
      console.warn("[REC] stopAudioStream returned null");
      return null;
    }
    console.log("[REC] native capture stopped uri=", uri);
    return uri;
  }, []);

  return {
    startRecording,
    stopRecording,
    isRecording,
    isRecordingRef,
  };
}
