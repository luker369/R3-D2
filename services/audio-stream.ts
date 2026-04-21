/**
 * Thin JS wrapper over the native AudioStreamModule. Owns an AudioRecord
 * on the Android side and streams per-frame dBFS via DeviceEventEmitter.
 * Decouples mic capture from the React render loop so background listening
 * actually works while the activity is paused.
 */

import { DeviceEventEmitter, NativeModules, Platform } from "react-native";

type Native = {
  start: (filePath: string) => Promise<boolean>;
  stop: () => Promise<{ durationMs: number; bytes: number }>;
  isActive: () => Promise<boolean>;
};

const native = (NativeModules as { AudioStreamModule?: Native })
  .AudioStreamModule;

const TAG = "[AudioStream]";

export type AudioFrame = { dbfs: number; ts: number };

let currentUri: string | null = null;

export function isAudioStreamSupported(): boolean {
  return Platform.OS === "android" && native != null;
}

function stripFileScheme(uri: string): string {
  return uri.replace(/^file:\/\//, "");
}

/**
 * Starts the native capture. `uri` is a `file://` URI — the path is stripped
 * before passing to native. Returns true on success.
 */
export async function startAudioStream(uri: string): Promise<boolean> {
  if (!native) {
    console.warn("[AudioStream] native module not available");
    return false;
  }
  console.log(TAG, "start request uri=", uri);
  try {
    const ok = await native.start(stripFileScheme(uri));
    if (ok) currentUri = uri;
    console.log(TAG, "start result=", ok);
    return ok;
  } catch (e) {
    console.warn("[AudioStream] start failed:", e);
    return false;
  }
}

/**
 * Stops the capture and returns the `file://` URI of the finalized WAV, or
 * null on failure / if not running.
 */
export async function stopAudioStream(): Promise<string | null> {
  if (!native) return null;
  console.log(TAG, "stop request uri=", currentUri);
  try {
    await native.stop();
    const uri = currentUri;
    currentUri = null;
    console.log(TAG, "stop result uri=", uri);
    return uri;
  } catch (e) {
    console.warn("[AudioStream] stop failed:", e);
    currentUri = null;
    return null;
  }
}

export async function isAudioStreamActive(): Promise<boolean> {
  if (!native) return false;
  try {
    return await native.isActive();
  } catch {
    return false;
  }
}

export function onAudioFrame(cb: (f: AudioFrame) => void): () => void {
  const sub = DeviceEventEmitter.addListener("R2AudioFrame", cb);
  return () => sub.remove();
}
