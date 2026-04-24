import 'react-native-url-polyfill/auto';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { useEffect } from 'react';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { R2_CHIRP_ON_EVERY_HOME_FOCUS } from '@/lib/r2-chirp-config';
import { playR2Chirp } from '@/lib/r2-chirp';
import { ErrorBoundary } from '@/components/error-boundary';
import { clearTokens } from '@/services/google-auth';
import { diagnoseGmail } from '@/services/gmail'; // [gmail-debug] REMOVE after verifying

export default function RootLayout() {
  const colorScheme = useColorScheme();

  useEffect(() => {
    console.log("[ROOT] RootLayout mounted");
    clearTokens();
    // [gmail-debug] One-shot Gmail diagnostic. REMOVE this line + the import
    // above once Gmail is verified working end-to-end.
    void diagnoseGmail();
    // Android immersive is handled natively in MainActivity (see
    // plugins/with-immersive-mode.js). The expo-navigation-bar JS API
    // is unreliable on SDK 54 / Android 15 and used to race the native
    // hide — removed to stop the flicker.
    if (R2_CHIRP_ON_EVERY_HOME_FOCUS) return;
    return playR2Chirp();
  }, []);

  return (
    <ErrorBoundary>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack screenOptions={{ headerShown: false }} />

        <StatusBar hidden />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
