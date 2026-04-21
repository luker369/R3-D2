/**
 * services/google-auth.ts
 *
 * Token storage and refresh only. OAuth flow lives in hooks/use-google-auth.ts.
 *
 * Tokens live in expo-secure-store (Android Keystore-backed) rather than in Supabase,
 * so a leaked anon key can't expose Google access.
 */

import * as SecureStore from 'expo-secure-store';
import { supabase } from './supabase';

const CLIENT_ID     = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID     ?? '';
const CLIENT_SECRET = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_SECRET ?? '';
const TOKEN_KEY     = 'google_tokens';
const LEGACY_ROW_KEY = 'google_tokens'; // old Supabase row content prefix

export type Tokens = {
  accessToken:  string;
  refreshToken: string;
  expiresAt:    number;
};

let cached: Tokens | null = null;

export async function saveTokens(tokens: Tokens): Promise<void> {
  cached = tokens;
  await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens));
}

async function loadTokens(): Promise<Tokens | null> {
  if (cached) return cached;
  const raw = await SecureStore.getItemAsync(TOKEN_KEY);
  if (raw) {
    try { cached = JSON.parse(raw) as Tokens; return cached; } catch { /* fall through */ }
  }
  // One-time migration from legacy Supabase-row storage → secure store
  try {
    const { data } = await supabase
      .from('memory_entries').select('content')
      .eq('category', 'system').like('content', `${LEGACY_ROW_KEY}=%`)
      .single();
    if (data?.content) {
      const migrated = JSON.parse((data.content as string).slice(LEGACY_ROW_KEY.length + 1)) as Tokens;
      cached = migrated;
      await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(migrated));
      await supabase.from('memory_entries').delete().eq('category', 'system').like('content', `${LEGACY_ROW_KEY}=%`);
      console.log('[google-auth] migrated tokens from Supabase → SecureStore');
      return migrated;
    }
  } catch { /* no legacy row */ }
  return null;
}

export async function clearTokens(): Promise<void> {
  cached = null;
  try { await SecureStore.deleteItemAsync(TOKEN_KEY); } catch {}
  try { await supabase.from('memory_entries').delete().eq('category', 'system').like('content', `${LEGACY_ROW_KEY}=%`); } catch {}
}

export async function isSignedIn(): Promise<boolean> {
  return (await loadTokens()) !== null;
}

export async function getAccessToken(): Promise<string | null> {
  let tokens = await loadTokens();
  if (!tokens) return null;

  if (Date.now() > tokens.expiresAt - 120_000) {
    if (!tokens.refreshToken) { cached = null; return null; }

    const params: Record<string, string> = {
      refresh_token: tokens.refreshToken,
      client_id:     CLIENT_ID,
      grant_type:    'refresh_token',
    };
    if (CLIENT_SECRET) params.client_secret = CLIENT_SECRET;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });

    if (!res.ok) { console.warn('[google-auth] refresh failed:', res.status); return null; }
    const json = await res.json();
    tokens = {
      accessToken:  json.access_token,
      refreshToken: json.refresh_token ?? tokens.refreshToken,
      expiresAt:    Date.now() + json.expires_in * 1000,
    };
    await saveTokens(tokens);
  }

  return tokens.accessToken;
}
