// Outbound alerts to Zoho Cliq.
//
// Why this exists: throttle detection already worked, but the verdict only ever
// landed on the in-memory job object and /status.html. On a sweep measured in
// days, nobody is watching that page -- so a squeezed IP stopped the run and the
// box then sat idle in silence. Detection without notification is not detection.
//
// Rules this file obeys, in order of importance:
//   1. Never throw. A notification failure must not touch a scrape. Every path
//      here catches, logs, and returns false.
//   2. Never block for long. A hung webhook must not stall the ASIN loop, so
//      every request carries its own abort timeout.
//   3. Never spam. A flapping IP could otherwise fire a message per ASIN.
//
// The endpoint is a Zoho Cliq incoming webhook:
//   POST https://cliq.zoho.com/company/<org>/api/v2/channelsbyname/<ch>/message?zapikey=...
// It answers 204 with an empty body on success. A bare {"text": "..."} is
// accepted -- no card or bot formatting is required.
import os from 'node:os';

const TIMEOUT_MS = 10000;

// Default floor between two messages sharing a key. Terminal events pass 0:
// "the job finished" must never be swallowed because a warning went out nine
// minutes earlier.
const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000;

const lastSent = new Map();

// Logged once rather than per call: an unconfigured webhook is a deployment
// choice, not an error, and it must not bury the scrape log.
let warnedMissing = false;

function webhookUrl() {
  const u = (process.env.CLIQ_WEBHOOK_URL || '').trim();
  return u || null;
}

export function notifyConfigured() {
  return !!webhookUrl();
}

/**
 * Post one message. Resolves true if Cliq accepted it, false in every other
 * case -- including "not configured" and "suppressed by the rate floor". It
 * never rejects.
 *
 * @param {string} text            message body
 * @param {object} [opts]
 * @param {string} [opts.key]      dedupe bucket; omit to bypass rate limiting
 * @param {number} [opts.minIntervalMs] floor for this key
 */
export async function notify(text, { key, minIntervalMs = DEFAULT_MIN_INTERVAL_MS } = {}) {
  const url = webhookUrl();
  if (!url) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn('[notify] CLIQ_WEBHOOK_URL is not set -- alerts are disabled for this process');
    }
    return false;
  }

  if (key && minIntervalMs > 0) {
    const prev = lastSent.get(key);
    if (prev && Date.now() - prev < minIntervalMs) {
      console.log(`[notify] suppressed "${key}" (last sent ${Math.round((Date.now() - prev) / 1000)}s ago)`);
      return false;
    }
  }

  // Reserve the slot before awaiting, not after. Two events landing in the same
  // tick would otherwise both see an empty bucket and both send.
  if (key) lastSent.set(key, Date.now());

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: ac.signal,
    });
    if (!res.ok) {
      // Never log the URL: it carries the zapikey.
      console.error(`[notify] Cliq returned HTTP ${res.status}`);
      // A rejected message did not land, so do not let it hold the bucket shut.
      if (key) lastSent.delete(key);
      return false;
    }
    return true;
  } catch (err) {
    const why = err.name === 'AbortError' ? `no response in ${TIMEOUT_MS}ms` : String(err.message || err);
    console.error(`[notify] send failed: ${why}`);
    if (key) lastSent.delete(key);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------
//
// runJob emits these through its onEvent callback; the server turns them into
// messages. Keeping the names here rather than as inline strings means the
// runner and the server cannot drift apart silently.
export const Event = {
  THROTTLE_WARNING: 'throttle_warning',
  THROTTLE_ABORT: 'throttle_abort',
  BOT_WALL: 'bot_wall',
  MARKUP_CHANGED: 'markup_changed',
  LOGGED_OUT: 'logged_out',
  EXTENSION_MISSING: 'extension_missing',
  BROWSER_DIED: 'browser_died',
  VERSION_MISMATCH: 'version_mismatch',
  LEDGER_UNREADABLE: 'ledger_unreadable',
};

// Message shape, deliberately tight:
//
//   <glyph> *<what happened>* — <the number that proves it>
//   → <what to do>            (only when a human must act)
//   <job> · <host>            (only when it identifies something)
//
// These arrive dozens of times over a multi-day sweep. Anything that is true of
// every alert, or that the reader can look up in the README once, is noise here
// -- it trains people to skim, which defeats the alert. Detail lives on
// /status.html and in the logs; this channel carries the trigger and the verb.
const GLYPH = {
  [Event.THROTTLE_WARNING]: '⚠️',
  [Event.THROTTLE_ABORT]: '🛑',
  [Event.BOT_WALL]: '🛑',
  [Event.MARKUP_CHANGED]: '🔴',
  [Event.LOGGED_OUT]: '🔴',
  [Event.EXTENSION_MISSING]: '🔴',
  [Event.BROWSER_DIED]: '🛑',
  [Event.VERSION_MISMATCH]: '⚠️',
  [Event.LEDGER_UNREADABLE]: '🔴',
};

const HEADLINE = {
  [Event.THROTTLE_WARNING]: 'Throttle suspected',
  [Event.THROTTLE_ABORT]: 'Stopped: IP throttled',
  [Event.BOT_WALL]: 'Stopped: bot walls',
  [Event.MARKUP_CHANGED]: 'Stopped: panel not parsing',
  [Event.LOGGED_OUT]: 'Stopped: H10 session lost',
  [Event.EXTENSION_MISSING]: 'Stopped: extension not loaded',
  [Event.BROWSER_DIED]: 'Stopped: browser died',
  [Event.VERSION_MISMATCH]: 'H10 extension updated',
  [Event.LEDGER_UNREADABLE]: 'Stopped: cannot read what is already done',
};

// One imperative each. Not an explanation -- the reasoning is in the README, and
// repeating it in every message is what made these unreadable.
const ACTION = {
  [Event.THROTTLE_ABORT]: 'Redeploy on a new IP, then re-upload the CSV',
  [Event.BOT_WALL]: 'Move the box — do not restart here',
  [Event.MARKUP_CHANGED]: 'npm run probe, then bump expectedExtensionVersion',
  [Event.LOGGED_OUT]: 'Sign in once with HEADLESS=0',
  [Event.EXTENSION_MISSING]: 'npm run fetch-ext, then restart',
  [Event.BROWSER_DIED]: 'Check VM memory, then re-upload the CSV',
  [Event.LEDGER_UNREADABLE]: 'Check the DB (npm run dbcheck), then re-upload',
};
// THROTTLE_WARNING and VERSION_MISMATCH carry no action on purpose: the run is
// still going and there is nothing to do yet. A "no action needed" line is
// exactly the kind of text that teaches people to stop reading.

/**
 * Format and send one run event. Dedupe is per job and per event type, so a
 * single job reports each condition once no matter how often it recurs.
 */
export function notifyEvent(event, { jobId, detail, processed, total } = {}) {
  // Progress goes before the detail, not after: the detail usually ends in a
  // number of its own ("stops at 6"), and two numbers running together read as
  // one clause.
  const at = Number.isFinite(processed) && Number.isFinite(total) ? ` at ${processed}/${total}` : '';
  const lines = [
    `${GLYPH[event] || 'ℹ️'} *${HEADLINE[event] || event}*${at}` +
      (detail ? ` — ${brief(detail)}` : ''),
  ];
  if (ACTION[event]) lines.push(`→ ${ACTION[event]}`);
  lines.push(footer(jobId));

  return notify(lines.join('\n'), {
    key: `${event}:${jobId || 'global'}`,
    // Once per job per event type. A run lasting longer than this window still
    // must not repeat itself, so the floor is effectively "forever for this job".
    minIntervalMs: Number.MAX_SAFE_INTEGER,
  });
}

/**
 * The end-of-run report. Always sent -- this is the message that tells you the
 * sweep advanced, and suppressing it because a warning went out earlier would
 * defeat the point.
 *
 * Four lines maximum. Counts, time, what is left. The status breakdown, the
 * per-table write counts and the rejected-token tally are all on /status.html
 * and none of them change what anyone does next.
 */
export function notifyJobDone(job, { backlogRemaining = null } = {}) {
  const failed = job.state === 'failed';
  const stopped = job.state === 'stopped';
  const glyph = failed ? '🔴' : job.aborted ? '⚠️' : stopped ? '⏹️' : '✅';
  const verb = failed ? 'Job failed' : stopped ? 'Job stopped' : job.aborted ? 'Job ended early' : 'Job done';

  const secs = job.startedAt && job.finishedAt
    ? (new Date(job.finishedAt) - new Date(job.startedAt)) / 1000
    : null;

  const done = (job.processed || 0) + (job.skipped || 0);
  const head =
    `${glyph} *${verb}* ${done}/${job.total || 0}` +
    (secs !== null ? ` · ${fmtDuration(secs)}` : '');

  // Only the three counts that mean different things: a real reading, a
  // confirmed absence, and work that is coming back.
  const counts =
    `${job.found || 0} found · ${job.missing || 0} no-data` +
    (job.retryCount ? ` · ${job.retryCount} unresolved` : '');

  const lines = [head, counts];
  if (job.aborted) lines.push(`Reason: ${brief(job.aborted)}`);
  if (job.error) lines.push(`Error: ${brief(job.error)}`);
  if (backlogRemaining !== null) {
    lines.push(`Backlog: ${backlogRemaining.toLocaleString('en-US')}`);
  }
  lines.push(footer(job.id));

  return notify(lines.join('\n'));
}

/**
 * The last job ended badly and nothing has been picked up since. The only alert
 * that can fire while the process is healthy -- the failure mode no in-run hook
 * can see, because there is no run.
 */
export function notifyIdle({ idleHours, backlogRemaining, reason, unfinished }) {
  const head =
    `😴 *Stalled ${idleHours.toFixed(1)}h* — last job ended early` +
    (unfinished ? `, ${unfinished.toLocaleString('en-US')} of its ASINs unfinished` : '');
  const lines = [head];
  if (reason) lines.push(`Reason: ${reason}`);
  if (backlogRemaining !== null && backlogRemaining !== undefined) {
    lines.push(`Backlog: ${backlogRemaining.toLocaleString('en-US')}`);
  }
  lines.push('→ Re-upload the CSV once the cause is fixed');
  lines.push(footer());
  return notify(
    lines.join('\n'),
    {
      key: 'idle',
      // Repeat rather than fire once: a single 2am message is easy to miss, and
      // the condition persists until someone acts on it.
      minIntervalMs: Number(process.env.IDLE_REPEAT_HOURS || 6) * 3600 * 1000,
    },
  );
}

/** The database is unreachable, so the scraper cannot write even if it runs. */
export function notifyDbDown(message) {
  return notify(
    [
      `🔴 *Database unreachable* — ${brief(message)}`,
      '→ Check the egress IP is whitelisted: npm run dbcheck',
      footer(),
    ].join('\n'),
    { key: 'db_down', minIntervalMs: 30 * 60 * 1000 },
  );
}

/** Sent once at boot, so an unexplained restart is visible. */
export function notifyStartup({ port }) {
  return notify(`🟢 *Scraper up* — :${port} · ${host()}`);
}

// The trailing identity line. Omitted entirely when there is no job to name and
// only one box, because a lone hostname on its own line is pure noise.
function footer(jobId) {
  return jobId ? `${String(jobId).slice(0, 8)} · ${host()}` : host();
}

// Alert text has to fit one glance. Several of the strings this receives are
// written for a terminal -- explain() in auth.js in particular returns a
// sentence of fact followed by a sentence of remedy, and the remedy is already
// in ACTION above. Keep the first sentence, cap the rest.
function brief(text, max = 90) {
  const t = String(text).trim().replace(/\s+/g, ' ');
  const firstStop = t.search(/\.\s|\.$|;\s/);
  const cut = firstStop > 0 ? t.slice(0, firstStop) : t;
  return cut.length > max ? cut.slice(0, max - 1).trimEnd() + '…' : cut;
}

function host() {
  try {
    // The mDNS ".local" suffix is on every hostname here and distinguishes
    // nothing, so it is dropped.
    return process.env.SCRAPER_HOST_LABEL || os.hostname().replace(/\.local$/, '');
  } catch {
    return 'unknown-host';
  }
}

function fmtDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.round(secs % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
