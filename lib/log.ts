/**
 * Minimal structured-log shim. Call sites stay identical (`log.info('TAG', ...)`)
 * and we can add session/turn correlation or remote transport later without
 * touching every file. Intentionally thin — this is a foothold, not a framework.
 *
 * Existing `console.*` calls across the codebase keep working; migration is
 * incremental. Prefer `log.*` in new code.
 */

type Fields = Record<string, unknown>;

function fmt(tag: string, msg: string, fields?: Fields): unknown[] {
  if (fields && Object.keys(fields).length > 0) {
    return [`[${tag}]`, msg, fields];
  }
  return [`[${tag}]`, msg];
}

export const log = {
  info: (tag: string, msg: string, fields?: Fields) => {
    console.log(...fmt(tag, msg, fields));
  },
  warn: (tag: string, msg: string, fields?: Fields) => {
    console.warn(...fmt(tag, msg, fields));
  },
  error: (tag: string, msg: string, err?: unknown, fields?: Fields) => {
    const merged: Fields = { ...(fields ?? {}) };
    if (err !== undefined) merged.err = err instanceof Error ? err.message : err;
    console.error(...fmt(tag, msg, merged));
  },
};
