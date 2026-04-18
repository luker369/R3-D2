/**
 * services/google-auth.ts
 *
 * Token storage and refresh only. OAuth flow lives in hooks/use-google-auth.ts.
 */

import { supabase } from './supabase';

const CLIENT_ID     = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID     ?? '';
const CLIENT_SECRET = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_SECRET ?? '';
const TOKEN_KEY     = 'google_tokens';

export type Tokens = {
  accessToken:  string;
  refreshToken: string;
  expiresAt:    number;
};

let cached: Tokens | null = null;

export async function saveTokens(tokens: Tokens): Promise<void> {
  cached = tokens;
  await supabase.from('memory_entries').delete().eq('category', 'system').like('content', `${TOKEN_KEY}=%`);
  await supabase.from('memory_entries').insert({ category: 'system', content: `${TOKEN_KEY}=${JSON.stringify(tokens)}` });
}

async function loadTokens(): Promise<Tokens | null> {
  if (cached) return cached;
  const { data } = await supabase
    .from('memory_entries').select('content')
    .eq('category', 'system').like('content', `${TOKEN_KEY}=%`)
    .single();
  if (!data) return null;
  try {
    cached = JSON.parse((data.content as string).slice(TOKEN_KEY.length + 1)) as Tokens;
    return cached;
  } catch { return null; }
}

export async function clearTokens(): Promise<void> {
  cached = null;
  await supabase.from('memory_entries').delete().eq('category', 'system').like('content', `${TOKEN_KEY}=%`);
}

export async function isSignedIn(): Promise<boolean> {
  return (await loadTokens()) !== null;
}

export async function getAccessToken(): Promise<string | null> {
  let tokens = await loadTokens();
  if (!tokens) return null;

  if (Date.now() > tokens.expiresAt - 120_000) {
    if (!tokens.refreshToken) { cached = null; return null; }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: tokens.refreshToken,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type:    'refresh_token',
      }).toString(),
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
