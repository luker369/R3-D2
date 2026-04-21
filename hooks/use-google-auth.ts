/**
 * hooks/use-google-auth.ts
 *
 * Uses expo-auth-session's Google provider with an Android OAuth client.
 * Implicit flow: returns an access_token directly (no refresh token).
 * Token lives for ~1 hour — user re-signs-in after expiry. Add a webClientId later for offline/refresh.
 */

import { useEffect } from 'react';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { saveTokens } from '@/services/google-auth';

WebBrowser.maybeCompleteAuthSession();

const ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '';

export function useGoogleSignIn(onConnected: () => void) {
  const [request, response, promptAsync] = Google.useAuthRequest({
    androidClientId: ANDROID_CLIENT_ID,
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
  });

  useEffect(() => {
    if (response?.type !== 'success') return;
    const { access_token, expires_in } = response.params;
    if (!access_token) {
      console.warn('[google-auth] no access_token in response:', response.params);
      return;
    }
    saveTokens({
      accessToken: access_token,
      refreshToken: '',
      expiresAt: Date.now() + (Number(expires_in) || 3600) * 1000,
    })
      .then(() => onConnected())
      .catch(err => console.warn('[google-auth] saveTokens failed:', err));
  }, [response]);

  return async () => {
    console.log('[google-auth] promptAsync called, request ready?', !!request, 'clientId set?', !!ANDROID_CLIENT_ID);
    if (!request) {
      console.warn('[google-auth] request is not ready — bailing');
      return;
    }
    try {
      const result = await promptAsync();
      console.log('[google-auth] promptAsync result type:', result?.type);
    } catch (e) {
      console.warn('[google-auth] promptAsync threw:', e);
    }
  };
}
