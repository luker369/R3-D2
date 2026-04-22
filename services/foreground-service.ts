/**
 * Android foreground service (Notifee) keeps the mic session eligible while you use other apps.
 * Requires a dev build where `@notifee/react-native` is linked — not available in Expo Go.
 */

import { AppState, NativeModules, Platform } from "react-native";

const TAG = "[FGS]";
const CHANNEL_ID = "r2r3_channel";
const NOTIFICATION_ID = "r2r3_foreground";

function isNotifeeNativeAvailable(): boolean {
  if (Platform.OS !== "android") return false;
  const nm = NativeModules as { NotifeeApiModule?: unknown };
  return nm.NotifeeApiModule != null;
}

type NotifeeModule = typeof import("@notifee/react-native");

let notifeeLoad: Promise<NotifeeModule> | null = null;

async function loadNotifee(): Promise<NotifeeModule | null> {
  if (!isNotifeeNativeAvailable()) return null;
  if (!notifeeLoad) notifeeLoad = import("@notifee/react-native");
  try {
    return await notifeeLoad;
  } catch (e) {
    console.warn(TAG, "notifee import failed:", e);
    return null;
  }
}

let running = false;
let starting: Promise<boolean> | null = null;
let registerDone = false;

export function isForegroundServiceRunning(): boolean {
  return running;
}

/**
 * Start the FGS and resolve only after the notification is posted and the
 * service is promoted to foreground. Returns true on success, false if the
 * platform/environment can't run it.
 *
 * Must be called while the app is in the `active` foreground state on
 * Android 12+ — calling from `background` throws
 * ForegroundServiceStartNotAllowedException.
 */
export async function startForegroundService(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  if (running) {
    console.log(TAG, "start short-circuit: already running");
    return true;
  }
  if (starting) {
    console.log(TAG, "start short-circuit: another start in flight, awaiting it");
    return starting;
  }

  starting = (async () => {
    const appState = AppState.currentState;
    if (appState !== "active") {
      console.warn(
        TAG,
        `startForegroundService called while AppState=${appState} — Android 12+ may reject this. Skipping.`,
      );
      return false;
    }

    const mod = await loadNotifee();
    if (!mod) {
      console.warn(TAG, "notifee native module unavailable; FGS not started");
      return false;
    }

    const notifee = mod.default;
    const { AndroidImportance, AndroidForegroundServiceType } = mod;

    try {
      // Android 13+ requires runtime POST_NOTIFICATIONS permission. Without
      // it, displayNotification silently no-ops and the FGS never promotes to
      // foreground — which strips background audio/mic privileges, causing
      // playback to wedge the moment the app is backgrounded.
      const perm = await notifee.requestPermission();
      console.log(
        TAG,
        "notification permission authorizationStatus=",
        perm.authorizationStatus,
      );

      if (!registerDone) {
        notifee.registerForegroundService(() => new Promise(() => {}));
        registerDone = true;
        console.log(TAG, "registered FGS runner");
      }

      await notifee.createChannel({
        id: CHANNEL_ID,
        name: "R2-R3 Assistant",
        description: "Keeps R2-R3 listening in the background",
        importance: AndroidImportance.LOW,
        vibration: false,
      });
      console.log(TAG, "channel ready");

      const NOTIF_BODY = "Listening...";
      console.log(
        TAG,
        `displayNotification call: id=${NOTIFICATION_ID} title="R2-R3" body="${NOTIF_BODY}" — note: this body is set once and never updated by any code path`,
      );
      await notifee.displayNotification({
        id: NOTIFICATION_ID,
        title: "R2-R3",
        body: NOTIF_BODY,
        android: {
          channelId: CHANNEL_ID,
          asForegroundService: true,
          foregroundServiceTypes: [
            AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            // MEDIA_PLAYBACK is required on Android 14+ for the audio
            // session to keep playing while backgrounded; without it,
            // setAudioModeAsync({ shouldPlayInBackground: true }) is
            // silently rejected and the player stalls (ready -> idle,
            // currentTime never advances) the moment the app is hidden.
            AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
          ],
          smallIcon: "ic_launcher",
          ongoing: true,
          // No pressAction: tapping/interacting with the notification must NOT
          // bring the app forward. Summon is via launcher icon or assist gesture.
          autoCancel: false,
        },
      });

      // Poll instead of a single instant check — there's a brief internal lag
      // between displayNotification returning and the notification appearing
      // in getDisplayedNotifications, which a single check can race even when
      // permission is fine.
      let posted = false;
      const verifyStartedAt = Date.now();
      while (Date.now() - verifyStartedAt < 1000) {
        const displayed = await notifee.getDisplayedNotifications();
        if (displayed.some((n) => n.id === NOTIFICATION_ID)) {
          posted = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!posted) {
        console.warn(
          TAG,
          "displayNotification returned but notification is not posted after 1s — likely missing POST_NOTIFICATIONS permission",
        );
        return false;
      }

      running = true;
      console.log(TAG, "started — notification posted, service promoted to foreground");
      return true;
    } catch (e) {
      console.warn(TAG, "start failed:", e);
      return false;
    }
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export async function stopForegroundService(): Promise<void> {
  if (Platform.OS !== "android" || !running) {
    if (Platform.OS === "android") {
      console.log(TAG, "stop short-circuit: not running");
    }
    return;
  }

  const mod = await loadNotifee();
  if (!mod) {
    running = false;
    return;
  }
  const notifee = mod.default;

  try {
    console.log(TAG, "stopForegroundService + cancelNotification call");
    await notifee.stopForegroundService();
    await notifee.cancelNotification(NOTIFICATION_ID);
    running = false;
    console.log(TAG, "stopped");
  } catch (e) {
    console.warn(TAG, "stop failed:", e);
  }
}
