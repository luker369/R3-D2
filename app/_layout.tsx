import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { useEffect } from 'react';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { R2_CHIRP_ON_EVERY_HOME_FOCUS } from '@/lib/r2-chirp-config';
import { playR2Chirp } from '@/lib/r2-chirp';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  useEffect(() => {
    console.log("[ROOT] RootLayout mounted");
    // Android immersive is handled natively in MainActivity (see
    // plugins/with-immersive-mode.js). The expo-navigation-bar JS API
    // is unreliable on SDK 54 / Android 15 and used to race the native
    // hide — removed to stop the flicker.
    if (R2_CHIRP_ON_EVERY_HOME_FOCUS) return;
    return playR2Chirp();
  }, []);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
      <StatusBar hidden />
    </ThemeProvider>
  );
}
