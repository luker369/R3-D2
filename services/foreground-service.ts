/**
 * Android foreground service (Notifee) keeps the mic session eligible while you use other apps.
 * Requires a dev build where `@notifee/react-native` is linked — not available in Expo Go.
 */

import { NativeModules, Platform } from "react-native";

const CHANNEL_ID = "r2r3_channel";
const NOTIFICATION_ID = "r2r3_foreground";

/** Notifee is not linked in Expo Go — never load the JS package there. */
function isNotifeeNativeAvailable(): boolean {
  if (Platform.OS !== "android") return false;
  const nm = NativeModules as { NotifeeApiModule?: unknown };
  return nm.NotifeeApiModule != null;
}

type NotifeeModule = typeof import("@notifee/react-native");

let notifeeLoad: Promise<NotifeeModule> | null = null;

async function loadNotifee(): Promise<NotifeeModule | null> {
  if (!isNotifeeNativeAvailable()) return null;
  if (!notifeeLoad) {
    notifeeLoad = import("@notifee/react-native");
  }
  try {
    return await notifeeLoad;
  } catch (e) {
    console.warn("[foreground-service] Notifee failed to load:", e);
    return null;
  }
}

let running = false;
let registerDone = false;

export async function startForegroundService(): Promise<void> {
  if (Platform.OS !== "android" || running) return;

  const mod = await loadNotifee();
  if (!mod) return;

  const notifee = mod.default;
  const { AndroidImportance, AndroidForegroundServiceType } = mod;

  try {
    if (!registerDone) {
      notifee.registerForegroundService(() => new Promise(() => {}));
      registerDone = true;
    }

    await notifee.createChannel({
      id: CHANNEL_ID,
      name: "R2-R3 Assistant",
      description: "Keeps R2-R3 listening in the background",
      importance: AndroidImportance.LOW,
      vibration: false,
    });
    await notifee.displayNotification({
      id: NOTIFICATION_ID,
      title: "R2-R3",
      body: "Listening...",
      android: {
        channelId: CHANNEL_ID,
        asForegroundService: true,
        foregroundServiceTypes: [
          AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
        ],
        smallIcon: "ic_launcher",
        ongoing: true,
        pressAction: { id: "default" },
      },
    });
    running = true;
  } catch (e) {
    console.warn("[foreground-service] start failed:", e);
  }
}

export async function stopForegroundService(): Promise<void> {
  if (Platform.OS !== "android" || !running) return;

  const mod = await loadNotifee();
  if (!mod) {
    running = false;
    return;
  }
  const notifee = mod.default;

  try {
    await notifee.stopForegroundService();
    await notifee.cancelNotification(NOTIFICATION_ID);
    running = false;
  } catch (e) {
    console.warn("[foreground-service] stop failed:", e);
  }
}
