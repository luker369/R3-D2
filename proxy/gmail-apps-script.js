/**
 * Google Apps Script — Gmail proxy for R2-D3.
 *
 * Deploy:
 *   1. Go to https://script.google.com → New project
 *   2. Paste this entire file into Code.gs (replace boilerplate)
 *   3. Change SHARED_SECRET below to a random string — same value goes into the app's .env
 *   4. Click Deploy → New deployment → Type: Web app
 *      - Description: R2-D3 Gmail proxy
 *      - Execute as: Me (your Google account)
 *      - Who has access: Anyone (auth happens via SHARED_SECRET, not Google)
 *   5. Authorize when prompted (first run only — grants Gmail permissions to the script)
 *   6. Copy the Web app URL → paste into the app's .env as EXPO_PUBLIC_APPS_SCRIPT_URL
 *
 * RE-DEPLOY when send/reply are added:
 *   Apps Script tracks scopes per deployed version. Because send and reply call
 *   GmailApp.sendEmail / thread.reply, a new Gmail *send* scope is required.
 *   After pasting the new code:
 *     Deploy → Manage deployments → pencil icon on existing deployment
 *       → Version: "New version" → Deploy → re-authorize when prompted.
 *   The Web app URL stays the same; no .env change needed.
 *
 * Why "Anyone"? Apps Script's "Anyone with Google account" still exposes the URL, but the
 * SHARED_SECRET check below rejects unauthenticated callers. Keep the secret out of version control.
 */

const SHARED_SECRET = 'CHANGE_ME_TO_A_RANDOM_STRING';

function doGet(e)  { return handle(e); }
function doPost(e) { return handle(e); }

function handle(e) {
  const params = (e && e.parameter) || {};
  if (params.secret !== SHARED_SECRET) {
    return json({ error: 'unauthorized' });
  }
  const action = params.action || 'recent';
  const count  = Math.min(Number(params.count) || 5, 20);
  try {
    if (action === 'recent')  return json(getRecent(count));
    if (action === 'unread')  return json(getUnread(count));
    if (action === 'search')  return json(searchGmail(params.q || '', count));
    if (action === 'send')    return json(sendNewEmail(params));
    if (action === 'reply')   return json(replyToThread(params));
    return json({ error: 'unknown action: ' + action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

function getRecent(count)           { return GmailApp.getInboxThreads(0, count).map(summarize); }
function getUnread(count)           { return GmailApp.search('is:unread in:inbox', 0, count).map(summarize); }
function searchGmail(query, count)  { return GmailApp.search(query, 0, count).map(summarize); }

function sendNewEmail(p) {
  const to = (p.to || '').trim();
  const subject = (p.subject || '(no subject)').trim();
  const body = p.body || '';
  if (!to) return { error: 'missing to' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { error: 'invalid to' };
  GmailApp.sendEmail(to, subject, body);
  return { ok: true };
}

function replyToThread(p) {
  const threadId = (p.threadId || '').trim();
  const body = p.body || '';
  if (!threadId) return { error: 'missing threadId' };
  if (!body.trim()) return { error: 'empty body' };
  const thread = GmailApp.getThreadById(threadId);
  if (!thread) return { error: 'thread not found' };
  thread.reply(body);
  return { ok: true };
}

function summarize(thread) {
  const msgs = thread.getMessages();
  const msg  = msgs[msgs.length - 1];
  return {
    id:      thread.getId(),
    from:    msg.getFrom(),
    subject: thread.getFirstMessageSubject(),
    date:    msg.getDate().toISOString(),
    snippet: msg.getPlainBody().slice(0, 300).replace(/\s+/g, ' ').trim(),
    unread:  thread.isUnread(),
  };
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
