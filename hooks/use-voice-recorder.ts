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

import { useState, useRef } from 'react';
import {
  AudioModule,
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  setAudioModeAsync,
} from 'expo-audio';

const METERING_INTERVAL_MS = 100; // poll 10× per second

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  // Ref mirrors isRecording but is synchronous — avoids stale-closure races
  // where stopRecording is called before React has committed the state update.
  const isRecordingRef = useRef(false);

  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });

  // Reactive state that updates every METERING_INTERVAL_MS while recording.
  // recorderState.metering is the current audio level in dB (negative; louder = closer to 0).
  const recorderState = useAudioRecorderState(recorder, METERING_INTERVAL_MS);

  async function startRecording(): Promise<boolean> {
    if (isRecordingRef.current) return true;

    const { granted } = await AudioModule.requestRecordingPermissionsAsync();
    if (!granted) {
      console.warn('[useVoiceRecorder] Microphone permission denied.');
      return false;
    }

    try {
      await setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      // Small gap lets Android release the TTS audio session before re-arming the mic
      await new Promise<void>(r => setTimeout(r, 150));
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (e) {
      console.warn('[useVoiceRecorder] Failed to start recording:', e);
      return false;
    }

    isRecordingRef.current = true;
    setIsRecording(true);
    return true;
  }

  async function stopRecording(): Promise<string | null> {
    if (!isRecordingRef.current) return null;
    isRecordingRef.current = false;
    setIsRecording(false);

    try {
      await recorder.stop();
    } catch (e) {
      console.warn('[useVoiceRecorder] stop() failed — recorder was not in a stoppable state:', e);
      return null;
    }

    const uri = recorder.uri;
    if (!uri) {
      console.warn('[useVoiceRecorder] No URI after stop.');
      return null;
    }

    return uri;
  }

  return {
    startRecording,
    stopRecording,
    isRecording,
    metering: recorderState.metering, // dB level, undefined when not recording
  };
}
