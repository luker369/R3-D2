import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as NavigationBar from 'expo-navigation-bar';

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
    if (Platform.OS === 'android') {
      // Immersive-sticky: hide the system nav bar entirely. A swipe from the
      // bottom edge reveals it transiently (overlay) then it auto-hides —
      // system back/home gestures still work without the visual affordance.
      NavigationBar.setBehaviorAsync('overlay-swipe').catch(() => {});
      NavigationBar.setVisibilityAsync('hidden').catch(() => {});
    }
    if (R2_CHIRP_ON_EVERY_HOME_FOCUS) return;
    return playR2Chirp();
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
