/**
 * hooks/use-google-auth.ts
 *
 * Manual Google OAuth flow (PKCE + auth code). Android OAuth clients do not
 * permit implicit flow — we must exchange a code.
 *
 * We use a belt-and-suspenders approach on Android:
 *   1. Start an auth session with expo-web-browser
 *   2. Also listen for the redirect via Linking.addEventListener
 *   3. Whichever resolves first wins
 *   4. Exchange the code for tokens
 *
 * The redirect URI uses the reversed Android client ID + :/oauth2redirect,
 * which is generated into the Android intent filter by app.config.js.
 */

import { useCallback } from 'react';
import { Linking } from 'react-native';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import { saveTokens } from '@/services/google-auth';

WebBrowser.maybeCompleteAuthSession();

function getExtraValue(key: string): string {
  const expoExtra =
    (Constants.expoConfig?.extra as Record<string, unknown> | undefined) ??
    ((Constants as typeof Constants & {
      manifest?: { extra?: Record<string, unknown> };
      manifest2?: { extra?: Record<string, unknown> };
    }).manifest2?.extra as Record<string, unknown> | undefined) ??
    ((Constants as typeof Constants & {
      manifest?: { extra?: Record<string, unknown> };
    }).manifest?.extra as Record<string, unknown> | undefined);

  const value = expoExtra?.[key];
  return typeof value === 'string' ? value : '';
}

const ANDROID_CLIENT_ID = getExtraValue('googleAndroidClientId');

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
    let settled = false;
    const finish = (url: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub?.remove();
      resolve(url);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sub?.remove();
      reject(new Error('timeout'));
    }, timeoutMs);

    Linking.getInitialURL()
      .then((url) => {
        if (url?.startsWith(redirectPrefix)) finish(url);
      })
      .catch(() => {});

    sub = Linking.addEventListener('url', (event) => {
      if (event.url.startsWith(redirectPrefix)) finish(event.url);
    });
  });
}

export function useGoogleSignIn(opts: Options | (() => void)) {
  const { onConnected, onError } =
    typeof opts === 'function' ? { onConnected: opts, onError: undefined } : opts;

  return useCallback(async () => {
    try {
      if (!ANDROID_CLIENT_ID) {
        onError?.('google android client id missing from app config');
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

      const redirectPrefix = `${reverseClientId(ANDROID_CLIENT_ID)}:`;
      const redirectPromise = waitForRedirect(redirectPrefix, 5 * 60 * 1000).then((url) => ({
        type: 'success' as const,
        url,
      }));

      const sessionPromise = WebBrowser.openAuthSessionAsync(authUrl, redirectUri)
        .then((result) => {
          if (result.type === 'success' && typeof result.url === 'string') {
            return { type: 'success' as const, url: result.url };
          }
          return { type: result.type };
        })
        .catch(() => ({ type: 'error' as const }));

      const sessionResult = await Promise.race([redirectPromise, sessionPromise]);

      if (sessionResult.type !== 'success') {
        onError?.(
          sessionResult.type === 'dismiss' || sessionResult.type === 'cancel'
            ? 'sign-in was cancelled'
            : 'sign-in timed out or was cancelled',
        );
        return;
      }

      try {
        await WebBrowser.dismissBrowser();
      } catch {}

      const redirectUrl = sessionResult.url;

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

      const tokenExchangeUrl = 'https://oauth2.googleapis.com/token';
      let tokenRes: Response;
      try {
        tokenRes = await fetch(tokenExchangeUrl, {
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
      } catch (err: any) {
        console.log('[NET ERROR] google-auth/exchange', tokenExchangeUrl, err?.message ?? err);
        throw err;
      }

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
