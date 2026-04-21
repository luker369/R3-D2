import { createAudioPlayer } from "expo-audio";

const R2_SOUND = require("../assets/103525__mik300z__r2-talk.mp3");

const PLAY_MS = 2500;

/**
 * Plays a short random slice of the R2 clip. Returns cleanup (stop + release).
 * Mirrors the previous root-layout behavior.
 */
export function playR2Chirp(): () => void {
  const player = createAudioPlayer(R2_SOUND);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;

  const poll = setInterval(() => {
    if (started) return;
    const duration = player.duration;
    if (!duration) return;
    started = true;
    clearInterval(poll);
    const startSec = Math.random() * Math.max(0, duration - PLAY_MS / 1000);
    void player.seekTo(startSec);
    player.play();
    timer = setTimeout(() => {
      try {
        player.pause();
        player.remove();
      } catch {}
    }, PLAY_MS);
  }, 50);

  const fallback = setTimeout(() => {
    if (started) return;
    clearInterval(poll);
    started = true;
    player.play();
    timer = setTimeout(() => {
      try {
        player.pause();
        player.remove();
      } catch {}
    }, PLAY_MS);
  }, 400);

  return () => {
    clearInterval(poll);
    clearTimeout(fallback);
    if (timer) clearTimeout(timer);
    try {
      player.pause();
      player.remove();
    } catch {}
  };
}
