/**
 * hooks/use-google-auth.ts
 */

import { useEffect } from 'react';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { saveTokens } from '@/services/google-auth';

WebBrowser.maybeCompleteAuthSession();

const DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint:         'https://oauth2.googleapis.com/token',
  revocationEndpoint:    'https://oauth2.googleapis.com/revoke',
};

export function useGoogleSignIn(onConnected: () => void) {
  const redirectUri = 'https://auth.expo.io/@your_exellency/R2-R3';

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId:     process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? '',
      scopes:       ['https://www.googleapis.com/auth/calendar.readonly'],
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
      usePKCE:      true,
      extraParams:  { access_type: 'offline', prompt: 'consent' },
    },
    DISCOVERY,
  );

  useEffect(() => {
    if (response?.type !== 'success') return;
    const { code } = response.params;
    if (!code) return;

    fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
        ...(request?.codeVerifier ? { code_verifier: request.codeVerifier } : {}),
      }).toString(),
    })
      .then(r => r.json())
      .then(json => {
        if (!json.access_token) return;
        return saveTokens({
          accessToken:  json.access_token,
          refreshToken: json.refresh_token ?? '',
          expiresAt:    Date.now() + (json.expires_in ?? 3600) * 1000,
        });
      })
      .then(() => onConnected())
      .catch(err => console.warn('[google-auth] token exchange failed:', err));
  }, [response]);

  return () => promptAsync();
}
