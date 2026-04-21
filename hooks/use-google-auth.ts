/**
 * hooks/use-google-auth.ts
 *
 * Manual Google OAuth flow (PKCE + auth code). Android OAuth clients do not
 * permit implicit flow — we must exchange a code.
 *
 * Instead of relying on WebBrowser.openAuthSessionAsync's redirect-detection
 * (which is unreliable with custom URI schemes on newer Chrome), we:
 *   1. openBrowserAsync to start the flow
 *   2. Listen for the redirect via Linking.addEventListener
 *   3. Close the browser when the URL arrives
 *   4. Exchange the code for tokens
 *
 * The redirect URI uses the reversed Android client ID + :/oauth2redirect,
 * which matches the intent filter in app.json.
 */

import { useCallback } from 'react';
import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import { saveTokens } from '@/services/google-auth';

WebBrowser.maybeCompleteAuthSession();

const ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '';

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

type Options = {
  onConnected: () => void;
  onError?: (msg: string) => void;
};

function reverseClientId(clientId: string): string {
  return 'com.googleusercontent.apps.' + clientId.replace(/\.apps\.googleusercontent\.com$/, '');
}

function randomString(len: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function base64ToBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function deriveChallenge(verifier: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  return base64ToBase64Url(digest);
}

function waitForRedirect(redirectPrefix: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let sub: { remove: () => void } | null = null;
    const timer = setTimeout(() => {
      sub?.remove();
      reject(new Error('timeout'));
    }, timeoutMs);
    sub = Linking.addEventListener('url', (event) => {
      if (event.url.startsWith(redirectPrefix)) {
        clearTimeout(timer);
        sub?.remove();
        resolve(event.url);
      }
    });
  });
}

export function useGoogleSignIn(opts: Options | (() => void)) {
  const { onConnected, onError } =
    typeof opts === 'function' ? { onConnected: opts, onError: undefined } : opts;

  return useCallback(async () => {
    try {
      if (!ANDROID_CLIENT_ID) {
        onError?.('client id missing from env');
        return;
      }

      const redirectUri = `${reverseClientId(ANDROID_CLIENT_ID)}:/oauth2redirect`;
      const state = randomString(16);
      const codeVerifier = randomString(64);
      const codeChallenge = await deriveChallenge(codeVerifier);

      const authUrl =
        'https://accounts.google.com/o/oauth2/v2/auth' +
        '?client_id=' + encodeURIComponent(ANDROID_CLIENT_ID) +
        '&redirect_uri=' + encodeURIComponent(redirectUri) +
        '&response_type=code' +
        '&scope=' + encodeURIComponent(SCOPES) +
        '&state=' + encodeURIComponent(state) +
        '&code_challenge=' + encodeURIComponent(codeChallenge) +
        '&code_challenge_method=S256' +
        '&access_type=offline' +
        '&prompt=consent';

      const redirectPromise = waitForRedirect(
        `${reverseClientId(ANDROID_CLIENT_ID)}:`,
        5 * 60 * 1000,
      );

      // Open in the system browser (not Chrome Custom Tabs) so the redirect
      // back to our custom URI scheme fires through Android's intent system.
      await Linking.openURL(authUrl);

      let redirectUrl: string;
      try {
        redirectUrl = await redirectPromise;
      } catch {
        onError?.('sign-in timed out or was cancelled');
        return;
      }

      const query = redirectUrl.includes('?') ? redirectUrl.split('?')[1].split('#')[0] : '';
      const params = new URLSearchParams(query);

      if (params.get('state') !== state) {
        onError?.('state mismatch');
        return;
      }
      const error = params.get('error');
      if (error) {
        onError?.('google: ' + error);
        return;
      }
      const code = params.get('code');
      if (!code) {
        onError?.('no code in redirect');
        return;
      }

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: ANDROID_CLIENT_ID,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          grant_type: 'authorization_code',
        }).toString(),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        onError?.(`token exchange ${tokenRes.status}: ${text.slice(0, 120)}`);
        return;
      }

      const tokens = await tokenRes.json();
      if (!tokens.access_token) {
        onError?.('no access_token in token response');
        return;
      }

      await saveTokens({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? '',
        expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      });
      onConnected();
    } catch (e) {
      onError?.('google sign-in threw: ' + String(e));
    }
  }, [onConnected, onError]);
}
