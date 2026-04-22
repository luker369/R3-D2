/**
 * services/gmail.ts
 *
 * Reads Gmail via Google Apps Script web apps (see proxy/gmail-apps-script.js).
 * Each script runs as the user's Google account — no OAuth in the app.
 * Auth is a SHARED_SECRET included as a URL param (HTTPS encrypts it in transit).
 *
 * Supports up to 3 Gmail accounts. Each account needs its own Apps Script deployment.
 * Env vars (EXPO_PUBLIC_* — inlined at Metro bundle time, so each must be referenced
 * statically by name here — dynamic indexing returns undefined in the release bundle):
 *   Account 1 (required): EXPO_PUBLIC_APPS_SCRIPT_URL, EXPO_PUBLIC_APPS_SCRIPT_SECRET
 *                         EXPO_PUBLIC_APPS_SCRIPT_LABEL (optional, default "main")
 *   Account 2/3 (optional): add _2 / _3 suffix to each.
 */

type Account = {
  label: string;
  url: string;
  secret: string;
};

export type GmailMessage = {
  id:      string;
  from:    string;
  subject: string;
  date:    string;
  snippet: string;
  unread:  boolean;
  account?: string;
};

// Static references so Expo's bundler can inline each value.
function loadAccounts(): Account[] {
  const raw = [
    {
      url:    process.env.EXPO_PUBLIC_APPS_SCRIPT_URL,
      secret: process.env.EXPO_PUBLIC_APPS_SCRIPT_SECRET,
      label:  process.env.EXPO_PUBLIC_APPS_SCRIPT_LABEL ?? 'main',
    },
    {
      url:    process.env.EXPO_PUBLIC_APPS_SCRIPT_URL_2,
      secret: process.env.EXPO_PUBLIC_APPS_SCRIPT_SECRET_2,
      label:  process.env.EXPO_PUBLIC_APPS_SCRIPT_LABEL_2 ?? 'account_2',
    },
    {
      url:    process.env.EXPO_PUBLIC_APPS_SCRIPT_URL_3,
      secret: process.env.EXPO_PUBLIC_APPS_SCRIPT_SECRET_3,
      label:  process.env.EXPO_PUBLIC_APPS_SCRIPT_LABEL_3 ?? 'account_3',
    },
  ];
  return raw
    .filter((e): e is Account => !!e.url && !!e.secret)
    .map(e => ({ label: e.label, url: e.url, secret: e.secret }));
}

export function getAccountLabels(): string[] {
  return loadAccounts().map(a => a.label);
}

export async function fetchRecentEmails(count = 5, label?: string): Promise<GmailMessage[]> {
  return call('recent', { count: String(count) }, label);
}

export async function fetchUnreadEmails(count = 5, label?: string): Promise<GmailMessage[]> {
  return call('unread', { count: String(count) }, label);
}

export async function searchEmails(query: string, count = 5, label?: string): Promise<GmailMessage[]> {
  return call('search', { q: query, count: String(count) }, label);
}

export type SendResult = { ok: true; account: string } | { ok: false; error: string; account?: string };

/**
 * Send a brand-new email. Routes to the first configured account unless a
 * label is given. Body is URL-encoded; fine for voice-dictated messages
 * (well under typical URL length limits).
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  label?: string,
): Promise<SendResult> {
  return callRaw('send', { to, subject, body }, label);
}

/**
 * Reply to an existing thread. The thread ID is the one returned in
 * GmailMessage.id from fetchRecentEmails / fetchUnreadEmails.
 */
export async function replyToThread(
  threadId: string,
  body: string,
  label?: string,
): Promise<SendResult> {
  return callRaw('reply', { threadId, body }, label);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function call(
  action: string,
  extra: Record<string, string>,
  labelFilter?: string,
): Promise<GmailMessage[]> {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    console.warn('[gmail] no accounts configured — set EXPO_PUBLIC_APPS_SCRIPT_URL + SECRET');
    return [];
  }

  const targets = labelFilter
    ? accounts.filter(a => a.label.toLowerCase() === labelFilter.toLowerCase())
    : accounts;
  if (targets.length === 0) {
    console.warn(`[gmail] no account matching label "${labelFilter}"`);
    return [];
  }

  const results = await Promise.all(targets.map(a => fetchOne(a, action, extra)));
  const merged = results.flat();
  merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const count = Math.max(1, Number(extra.count) || 5);
  return merged.slice(0, count);
}

/**
 * Single-account write call. Unlike `call()` which fans out across accounts
 * for reads, writes pick exactly one account: the label-matched one, or the
 * first configured account (primary/main) if no label given.
 */
async function callRaw(
  action: string,
  extra: Record<string, string>,
  labelFilter?: string,
): Promise<SendResult> {
  const accounts = loadAccounts();
  if (accounts.length === 0) return { ok: false, error: 'no_accounts' };

  const target = labelFilter
    ? accounts.find(a => a.label.toLowerCase() === labelFilter.toLowerCase())
    : accounts[0];
  if (!target) return { ok: false, error: `no_matching_label:${labelFilter}` };

  const params = new URLSearchParams({ secret: target.secret, action, ...extra });
  const url = `${target.url}?${params.toString()}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, 15_000);
      const data = await res.json();
      if (data && data.error) {
        return { ok: false, error: String(data.error), account: target.label };
      }
      if (data && data.ok) {
        console.log(`[gmail] ${action} ok via ${target.label}`);
        return { ok: true, account: target.label };
      }
      return { ok: false, error: 'unexpected_response', account: target.label };
    } catch (e: any) {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 400 + Math.floor(Math.random() * 300)));
        continue;
      }
      console.warn(`[gmail] ${action} failed on ${target.label}:`, e);
      return { ok: false, error: e?.message ?? String(e), account: target.label };
    }
  }
  return { ok: false, error: 'unreachable', account: target.label };
}

async function fetchOne(
  acc: Account,
  action: string,
  extra: Record<string, string>,
): Promise<GmailMessage[]> {
  const params = new URLSearchParams({
    secret: acc.secret,
    action,
    ...extra,
  });
  const url = `${acc.url}?${params.toString()}`;

  // Apps Script 302-redirects once to script.googleusercontent.com; mobile networks
  // sometimes drop that. One retry with backoff recovers silently.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res  = await fetchWithTimeout(url, 12_000);
      const json = await res.json();
      if (json && json.error) {
        console.warn(`[gmail] error from ${acc.label}:`, json.error);
        return [];
      }
      if (!Array.isArray(json)) return [];
      return (json as GmailMessage[]).map(m => ({ ...m, account: acc.label }));
    } catch (e) {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 400 + Math.floor(Math.random() * 300)));
        continue;
      }
      console.warn(`[gmail] ${acc.label} fetch failed after retry:`, e);
      return [];
    }
  }
  return [];
}
