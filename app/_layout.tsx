import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { useEffect } from 'react';
import { createAudioPlayer } from 'expo-audio';

import { useColorScheme } from '@/hooks/use-color-scheme';

const R2_SOUND = require('../assets/103525__mik300z__r2-talk.mp3');

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  useEffect(() => {
    const PLAY_MS = 2500;
    const player = createAudioPlayer(R2_SOUND);

    let timer: ReturnType<typeof setTimeout>;
    let started = false;

    const poll = setInterval(() => {
      if (started) return;
      const duration = player.duration;
      if (!duration) return;
      started = true;
      clearInterval(poll);
      const startSec = Math.random() * Math.max(0, duration - PLAY_MS / 1000);
      player.seekTo(startSec);
      player.play();
      timer = setTimeout(() => { try { player.pause(); player.remove(); } catch {} }, PLAY_MS);
    }, 50);

    // Fallback if duration never resolves
    const fallback = setTimeout(() => {
      if (started) return;
      clearInterval(poll);
      started = true;
      player.play();
      timer = setTimeout(() => { try { player.pause(); player.remove(); } catch {} }, PLAY_MS);
    }, 400);

    return () => {
      clearInterval(poll);
      clearTimeout(fallback);
      clearTimeout(timer);
      try { player.pause(); player.remove(); } catch {}
    };
  }, []);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
