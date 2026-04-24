/**
 * services/supabase.ts
 *
 * Supabase client instance, shared across the app.
 *
 * Auth is disabled since this step has no user accounts.
 * persistSession: false avoids the AsyncStorage dependency entirely.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

console.log('SUPABASE URL:', process.env.EXPO_PUBLIC_SUPABASE_URL);
console.log('SUPABASE KEY EXISTS:', !!process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
// Loud at module load — without these, queries construct fine but fail later
// with opaque "fetch failed" errors that are a pain to trace.
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    '[supabase] EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY is missing — ' +
    'memory reads/writes will all fail. Set them in .env and rebuild.',
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
