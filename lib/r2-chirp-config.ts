/**
 * R2 startup chirp behavior (see `lib/r2-chirp.ts`).
 *
 * - `true` — play each time the Home screen is **focused** (open app, return to this tab).
 * - `false` — play **once per cold start** only (original behavior, root layout).
 *
 * Flip to `false` if you don’t want the “every visit” chirp.
 */
export const R2_CHIRP_ON_EVERY_HOME_FOCUS = true;
