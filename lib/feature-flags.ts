/**
 * One-line kill switches for subsystems that can be disabled without a code
 * change — flip the constant and rebuild. Each flag names what it gates and
 * what breaks when it's off.
 *
 * Do not import from application code conditionally (e.g. `if (flag) require…`).
 * Guards should be cheap boolean checks at the call site so dead code stays
 * type-checked.
 */

// Gates OpenAI's hosted web_search_preview tool in services/openai.ts.
// When false, the tool is never attached regardless of the JS-side intent
// gate — same shape as the current "block" decision from shouldUseWebSearch.
export const ENABLE_WEB_SEARCH = true;

// Gates post-turn memory extraction (services/memory.ts → extractAndSaveMemory).
// When false, conversations still work; nothing is persisted to Supabase from
// automatic extraction. Explicit saveEntry calls still run.
export const ENABLE_MEMORY_EXTRACTION = true;

// Gates the Android Notifee foreground service (services/foreground-service.ts).
// When false, the app still listens while foregrounded; it will lose the mic
// and playback the moment it's backgrounded. Useful if Notifee starts misbehaving.
export const ENABLE_FGS = true;

// Kept here so all flags live in one place. Existing import in lib/r2-chirp-config
// stays valid — this file re-exports the same constant.
export { R2_CHIRP_ON_EVERY_HOME_FOCUS } from './r2-chirp-config';
