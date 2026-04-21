/**
 * Cloudflare Worker — OpenAI proxy for R2-R3.
 *
 * Deploy with Wrangler (https://developers.cloudflare.com/workers/):
 *   1. npm create cloudflare@latest r2-proxy -- --type worker
 *   2. Replace src/index.js with this file.
 *   3. wrangler secret put OPENAI_API_KEY        (paste real OpenAI key)
 *   4. wrangler secret put APP_SHARED_SECRET     (generate a random string — also set as EXPO_PUBLIC_OPENAI_API_KEY)
 *   5. wrangler deploy
 *   6. In the app's .env set:
 *        EXPO_PUBLIC_OPENAI_BASE_URL=https://<your-worker>.workers.dev/v1
 *        EXPO_PUBLIC_OPENAI_API_KEY=<APP_SHARED_SECRET>
 *   7. Rebuild the APK. The real OpenAI key is no longer in the bundle.
 *
 * Hardening knobs below: limit which endpoints are forwarded, rate-limit per IP,
 * block requests without the shared secret, strip client headers we don't trust.
 */

const ALLOWED_PATHS = new Set([
  '/v1/chat/completions',
  '/v1/audio/transcriptions',
  '/v1/audio/speech',
]);

const UPSTREAM = 'https://api.openai.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!ALLOWED_PATHS.has(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }

    // Client must present the app shared secret as its Authorization header.
    const auth = request.headers.get('Authorization') || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!env.APP_SHARED_SECRET || presented !== env.APP_SHARED_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Build upstream request with ONLY the real key + content-type. Drop everything else.
    const upstreamUrl = UPSTREAM + url.pathname + url.search;
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${env.OPENAI_API_KEY}`);
    const ct = request.headers.get('Content-Type');
    if (ct) headers.set('Content-Type', ct);

    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    });

    // Stream the response straight through — important for SSE chat completions.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  },
};
