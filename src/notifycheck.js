// Prove the alerting path works from THIS host, without scraping anything.
//
// This is the deploy-time counterpart to `npm run dbcheck`. The webhook was
// verified from an office connection; whether it works from a datacenter egress
// IP is a separate question, and it is the kind of question that is only ever
// answered at 3am by an alert that never arrived.
//
//   npm run notifycheck             one plain test message
//   npm run notifycheck -- --full   one of every alert shape, for formatting
import { loadEnv } from './db.js';
import {
  notify, notifyConfigured, notifyEvent, notifyJobDone, notifyIdle, Event,
} from './notify.js';

loadEnv();

if (!notifyConfigured()) {
  console.error('CLIQ_WEBHOOK_URL is not set in .env -- nothing to test.');
  process.exit(1);
}

const full = process.argv.includes('--full');
const label = process.env.SCRAPER_HOST_LABEL || '(hostname)';
console.log(`sending ${full ? 'all alert shapes' : 'one test message'} as ${label}`);

let ok = await notify(
  `🧪 *Alert check* — sent by \`npm run notifycheck\`, no job running · ${label}`,
);
console.log(ok ? '  plain message: delivered' : '  plain message: FAILED (see the error above)');

if (full) {
  // A fake job id, so the per-job dedupe buckets used by real runs are not
  // consumed by a test.
  const jobId = 'testtest-0000-0000-0000-000000000000';

  await notifyEvent(Event.THROTTLE_WARNING, {
    jobId,
    detail: '3 consecutive timeouts. The panel is not populating, which is what a squeezed IP looks like before it becomes a hard block. Will stop at 6.',
    processed: 142,
    total: 500,
  });

  await notifyEvent(Event.MARKUP_CHANGED, {
    jobId,
    detail: '3 consecutive pages whose panel did not parse; panel reports v8.43.0',
    processed: 88,
    total: 500,
  });

  await notifyJobDone(
    {
      id: jobId,
      state: 'completed',
      filename: 'backlog-2026-09-01',
      marketplace: 'US',
      total: 500,
      skipped: 12,
      processed: 488,
      found: 209,
      missing: 254,
      errors: 25,
      insertedFound: 209,
      insertedMissing: 279,
      retryCount: 25,
      byStatus: { OK: 209, NO_DATA: 231, REDIRECTED: 23, TIMEOUT: 25 },
      aborted: null,
      startedAt: new Date(Date.now() - 3 * 3600_000 - 12 * 60_000).toISOString(),
      finishedAt: new Date().toISOString(),
    },
    { backlogRemaining: 71629 },
  );

  await notifyIdle({
    idleHours: 4.2,
    backlogRemaining: 70583,
    reason: '6 consecutive timeouts -- the panel is not populating',
    unfinished: 3000,
  });

  console.log('  sent: throttle warning, markup changed, job done, idle');
}

console.log('done -- check the velocityxtechnotification channel');
process.exit(ok ? 0 : 1);
