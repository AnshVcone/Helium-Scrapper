import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { loadEnv, ping, getPool, writeMissing, MissingReason, UnresolvedCode,
         backlogAsins, backlogCount, dbTarget } from './db.js';
import { runJob, parseAsins } from './runner.js';
import { notifyEvent, notifyJobDone, notifyIdle, notifyDbDown, notifyStartup,
         notifyConfigured } from './notify.js';

loadEnv();

const app = express();
app.use(express.text({ type: ['text/*', 'application/csv'], limit: '32mb' }));

// Log mutating and job requests. Without this there is no way to tell an upload
// that never arrived from one that arrived and failed -- which is exactly the
// question that came up first in real use.
app.use((req, _res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/jobs')) {
    console.log(`[server] ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  }
  next();
});

// Upload form and status page, served from the same process so a deployed
// container needs no separate front end.
app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));

// CSVs are held in memory and discarded after parsing -- an ASIN list does not
// need to persist on disk, and not writing it avoids leaving copies around.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// Job state
// ---------------------------------------------------------------------------

// The browser is a single serial resource, so exactly one job runs at a time and
// the rest queue. Running two would double Amazon-facing traffic from one IP,
// which is the thing most likely to get the run throttled.
const jobs = new Map();
const queue = [];
let active = null;

// runner Status -> the error_code stored beside panel_unresolved. The reason
// column carries the retry decision; this says which way the read failed.
const UNRESOLVED_CODE = {
  TIMEOUT: UnresolvedCode.TIMEOUT,
  BLOCKED: UnresolvedCode.BLOCKED,
  SHAPE_UNKNOWN: UnresolvedCode.SHAPE_UNKNOWN,
  DISCONNECTED: UnresolvedCode.DISCONNECTED,
  NOT_LOGGED_IN: UnresolvedCode.LOGGED_OUT,
};

const JOBS_FILE = path.join(config.root, 'output', 'jobs.json');
const retryPath = (id) => path.join(config.root, 'output', `retry-${id}.csv`);

function persist() {
  try {
    fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
    fs.writeFileSync(JOBS_FILE, JSON.stringify([...jobs.values()], null, 2));
  } catch (e) {
    console.error('[server] could not persist job state:', e.message);
  }
}

// Job history is written to disk on every change but was never read back, so a
// restart made the status page look like nothing had ever been uploaded. Restore
// it, and force anything that was mid-flight into a terminal state: its work died
// with the old process, so leaving it "running" would show a job that can never
// progress.
function restore() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    let requeued = 0;
    for (const j of saved) {
      j._stop = false;
      j._retryAsins = [];
      j._attemptedAsins = [];
      j._neverAttemptedAsins = [];
      const interrupted = j.state === 'running' || j.state === 'queued';

      if (interrupted && Array.isArray(j._asins) && j._asins.length) {
        // Re-queue rather than discard. Re-running the full list is safe and
        // cheap: ASINs that already settled are skipped by the ledger check, so
        // a resumed job only pays for what is genuinely outstanding.
        j.state = 'queued';
        j.aborted = null;
        jobs.set(j.id, j);
        queue.push(j.id);
        requeued++;
        continue;
      }

      if (interrupted) {
        j.state = 'stopped';
        j.aborted = 'server restarted mid-run and the ASIN list was not recoverable';
        j.finishedAt = j.finishedAt || new Date().toISOString();
      }
      j._asins = [];
      jobs.set(j.id, j);
    }
    console.log(
      `[server] restored ${saved.length} job(s) from ${JOBS_FILE}` +
      (requeued ? `; re-queued ${requeued} interrupted job(s)` : ''),
    );
  } catch (e) {
    console.error('[server] could not restore job state:', e.message);
  }
}

function newJob({ asins, rejected = [], marketplace, filename }) {
  const job = {
    id: crypto.randomUUID(),
    state: 'queued',
    filename: filename || null,
    marketplace,
    fetchDate: new Date().toISOString().slice(0, 10),
    total: asins.length,
    rejectedTokens: rejected.length,
    skipped: 0,
    processed: 0,
    retryCount: 0,
    found: 0,
    missing: 0,
    errors: 0,
    insertedFound: 0,
    insertedMissing: 0,
    byStatus: {},
    current: null,
    aborted: null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    _asins: asins,
    _stop: false,
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  persist();
  pump();
  return job;
}

// Strip internals before returning a job over HTTP.
function view(job) {
  const { _asins, _stop, _retryAsins, _attemptedAsins, _neverAttemptedAsins,
          _retryDetail, ...rest } = job;
  // Skipped ASINs are resolved work, so they count toward completion -- without
  // this the bar would stall below 100% on any re-upload.
  const accounted = rest.processed + rest.skipped;
  const remaining = Math.max(0, rest.total - accounted);
  return {
    ...rest,
    remaining,
    percent: rest.total ? Math.round((accounted / rest.total) * 100) : 0,
    completed: ['completed', 'aborted', 'failed', 'stopped'].includes(rest.state),
  };
}

async function pump() {
  if (active || !queue.length) return;

  const id = queue.shift();
  const job = jobs.get(id);
  if (!job) return pump();

  active = id;
  job.state = 'running';
  job.startedAt = new Date().toISOString();
  persist();

  try {
    const summary = await runJob({
      asins: job._asins,
      marketplace: job.marketplace,
      fetchDate: job.fetchDate,
      shouldStop: () => job._stop,
      // Fire-and-forget on purpose. notify() swallows its own failures, so there
      // is nothing here worth awaiting and nothing that can reject -- and making
      // the ASIN loop wait on an HTTP round trip to Cliq would be absurd.
      onEvent: (event, meta) => {
        notifyEvent(event, { jobId: job.id, ...meta }).catch(() => {});
      },
      onProgress: (s) => {
        Object.assign(job, {
          skipped: s.skipped,
          processed: s.processed,
          found: s.found,
          missing: s.missing,
          errors: s.errors,
          insertedFound: s.insertedFound,
          insertedMissing: s.insertedMissing,
          byStatus: s.byStatus,
          current: s.current,
        });
      },
    });

    // Persist the retry list to disk, so the ASINs needing another pass survive
    // a restart and can be re-submitted without re-uploading the whole sheet.
    job._retryAsins = summary.retryAsins || [];
    job._attemptedAsins = summary.attemptedAsins || [];
    job._neverAttemptedAsins = summary.neverAttemptedAsins || [];
    job._retryDetail = summary.retryDetail || {};
    if (summary.retryAsins?.length) {
      try {
        fs.mkdirSync(path.join(config.root, 'output'), { recursive: true });
        fs.writeFileSync(retryPath(job.id), summary.retryAsins.join('\n') + '\n');
      } catch (e) {
        console.error('[server] could not write retry list:', e.message);
      }
    }

    Object.assign(job, {
      skipped: summary.skipped,
      retryCount: summary.retryAsins?.length || 0,
      processed: summary.processed,
      found: summary.found,
      missing: summary.missing,
      errors: summary.errors,
      insertedFound: summary.insertedFound,
      insertedMissing: summary.insertedMissing,
      byStatus: summary.byStatus,
      aborted: summary.aborted,
      throttleSuspected: !!summary.throttleSuspected,
      current: null,
      // A run that gave up is NOT 'completed'. Reporting an abort as completed
      // is what made a job that stopped at 126 of 545 look finished on the
      // status page, with the reason buried in a field nobody reads.
      state: job._stop ? 'stopped' : summary.aborted ? 'aborted' : 'completed',
      // Diagnostics that were computed and then thrown away: without these
      // there was no way to tell from the status page whether the false-logout
      // guard had tripped or a real re-login had been attempted.
      relogins: summary.relogins || 0,
      falseLogouts: summary.falseLogouts || 0,
    });
  } catch (err) {
    job.state = 'failed';
    job.error = String(err.message || err).slice(0, 500);
    console.error(`[server] job ${job.id} failed:`, err);
  } finally {
    job.finishedAt = new Date().toISOString();
    const attempted = job._attemptedAsins || [];
    const neverAttempted = job._neverAttemptedAsins || [];
    // The ASIN list is the bulk of the memory; drop it once the job is done.
    job._asins = [];
    active = null;

    // No automatic retry. An ASIN we could not read is recorded in the missing
    // table so the next upload picks it up. Retrying inline would re-walk the
    // same pages in the same conditions -- on a large sheet that is hours spent
    // re-failing.
    //
    // Only ASINs the run actually opened are written. A run aborted at 2,000 of
    // 5,000 never touched the last 3,000, and marking those "we tried and
    // failed" is simply false -- they get no row, and the CSV you re-upload is
    // the record that they are still owed.
    if (attempted.length) {
      const detail = job._retryDetail || {};
      const entries = attempted.map((asin) => ({
        asin,
        reason: MissingReason.UNRESOLVED,
        errorCode: UNRESOLVED_CODE[detail[asin]] || UnresolvedCode.TIMEOUT,
        errorMessage: `no reading this run; last outcome ${detail[asin] || 'unknown'}`,
      }));
      try {
        const n = await writeMissing(entries, job.marketplace, job.fetchDate);
        job.insertedMissing += n;
        job.unresolvedWritten = n;
        console.log(
          `[server] wrote ${n} ${MissingReason.UNRESOLVED} row(s); ` +
          `${neverAttempted.length} ASIN(s) were never reached and got none`,
        );
      } catch (e) {
        console.error('[server] could not record unresolved ASINs:', e.message);
      }
    }

    persist();

    // The end-of-run report. Sent for every terminal state including failure --
    // "the job died" is more worth knowing than "the job finished", and both
    // arrive the same way so neither depends on someone watching /status.html.
    //
    // Deliberately after persist() and before pump(): the job record is already
    // durable, and the next queued job does not wait on a webhook round trip.
    let backlogRemaining = null;
    try {
      const counts = await backlogCount({ marketplace: job.marketplace });
      backlogRemaining = Number(counts.outstanding);
    } catch (e) {
      // A backlog figure is a nice-to-have in the report; losing it must not
      // cost the report itself.
      console.error('[server] backlog count for the completion alert failed:', e.message);
    }
    notifyJobDone(job, { backlogRemaining }).catch(() => {});
    // Work happened, so the idle clock restarts from here.
    lastJobFinishedAt = Date.now();

    pump();
  }
}

// ---------------------------------------------------------------------------
// Idle watchdog
// ---------------------------------------------------------------------------
//
// Every alert above fires from inside a run. None can report the failure mode
// that matters most on a multi-day sweep: a run aborted at 3am, leaving a
// healthy process and an empty queue -- silent by every other measure.
//
// The trigger is deliberately NOT "there is backlog in the database". Work only
// arrives by CSV upload now, so an idle box with backlog outstanding is usually
// just waiting for you, and alerting on that would cry wolf every night.
//
// What is always wrong is an *abnormal* end with nothing picked up since: the
// last job aborted or failed, no new upload has arrived, and hours have passed.
// That is the run nobody noticed had stopped.
let lastJobFinishedAt = Date.now();

const IDLE_ALERT_HOURS = Number(process.env.IDLE_ALERT_HOURS || 3);
const IDLE_CHECK_MS = 15 * 60 * 1000;

async function idleCheck() {
  if (active || queue.length) {
    lastJobFinishedAt = Date.now();
    return;
  }
  const idleHours = (Date.now() - lastJobFinishedAt) / 3600000;
  if (idleHours < IDLE_ALERT_HOURS) return;

  // Only an abnormal ending is worth waking someone for. A job that completed
  // cleanly and no upload since means the sweep is between sheets, which is a
  // normal state and not news.
  const last = [...jobs.values()]
    .filter((j) => j.finishedAt)
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
    .pop();
  if (!last || !(last.aborted || last.state === 'failed')) return;

  let outstanding = null;
  try {
    const counts = await backlogCount({ marketplace: last.marketplace || 'US' });
    outstanding = Number(counts.outstanding);
  } catch (e) {
    // An unreachable database is itself the alert -- and on a fresh VM it is the
    // single most likely cause, since the egress IP has to be whitelisted by
    // hand on the staging host.
    notifyDbDown(e.message).catch(() => {});
    return;
  }

  notifyIdle({
    idleHours,
    backlogRemaining: outstanding,
    reason: brief(last.error || last.aborted),
    unfinished: Math.max(0, (last.total || 0) - ((last.processed || 0) + (last.skipped || 0))),
  }).catch(() => {});
}

// Trim a terminal-length message down to one clause for an alert line.
function brief(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  const stop = t.search(/\.\s|\.$/);
  const cut = stop > 0 ? t.slice(0, stop) : t;
  return cut.length > 80 ? cut.slice(0, 79).trimEnd() + '…' : cut;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', async (_req, res) => {
  try {
    const info = await ping();
    const t = dbTarget();
    res.json({
      ok: true,
      mode: t.mode,
      db: info.db,
      host: t.host,
      user: info.usr,
      tablePrefix: t.tablePrefix,
      activeJob: active,
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: String(err.message || err) });
  }
});

// Upload a CSV of ASINs and start a job.
//   curl -F 'file=@asins.csv' localhost:8090/jobs
//   curl -H 'Content-Type: text/csv' --data-binary @asins.csv localhost:8090/jobs
app.post('/jobs', upload.single('file'), (req, res) => {
  const raw = req.file ? req.file.buffer.toString('utf8') : req.body;
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({
      error: 'No CSV supplied. Send multipart form field "file", or the CSV as the request body with Content-Type: text/csv.',
    });
  }

  const { asins, rejected } = parseAsins(raw);
  if (!asins.length) {
    return res.status(400).json({
      error: 'No valid ASINs found in the upload.',
      rejectedSample: rejected.slice(0, 10),
    });
  }

  const job = newJob({
    asins,
    rejected,
    marketplace: (req.query.marketplace || 'US').toString().toUpperCase(),
    filename: req.file?.originalname,
  });

  res.status(202).json({
    jobId: job.id,
    accepted: asins.length,
    rejectedTokens: rejected.length,
    rejectedSample: rejected.slice(0, 10),
    state: job.state,
    statusUrl: `/jobs/${job.id}`,
  });
});

// The outstanding backlog, derived from the database alone. A replacement server
// needs no CSV and no migrated job file: the two tables know what has settled.
// Give-ups (panel_unresolved) are deliberately included -- a
// failure caused by a throttled IP should not be a permanent verdict.
app.get('/backlog', async (req, res) => {
  const marketplace = (req.query.marketplace || 'US').toString().toUpperCase();
  try {
    const counts = await backlogCount({ marketplace });
    res.json({ marketplace, ...counts });
  } catch (err) {
    res.status(503).json({ error: String(err.message || err) });
  }
});

// Same set as a CSV, ready to feed straight back into POST /jobs.
app.get('/backlog.csv', async (req, res) => {
  const marketplace = (req.query.marketplace || 'US').toString().toUpperCase();
  const limit = Math.min(Number(req.query.limit) || 1000, 200000);
  const today = new Date().toISOString().slice(0, 10);
  try {
    const asins = await backlogAsins({ marketplace, limit });
    res.type('text/csv')
       .set('Content-Disposition', `attachment; filename="backlog-${today}.csv"`)
       .send(asins.join('\n') + (asins.length ? '\n' : ''));
  } catch (err) {
    res.status(503).type('text/plain').send(String(err.message || err));
  }
});

// There is deliberately no endpoint that starts a job from the backlog.
//
// The scraper runs what you upload and nothing else. A job's ASIN list comes
// from exactly two places -- POST /jobs (your CSV) and restore() replaying that
// same list after a restart -- and neither invents work from the database. The
// backlog views below are read-only: /backlog.csv hands you a file, and it is
// your decision to upload it.
//
// This reverses the 2026-08-27 "no local state" design, where a replacement
// server rebuilt its work list from the DB alone. The trade is deliberate: a new
// box now needs the CSV, so keep the sheets somewhere you can re-upload from.

app.get('/jobs', (_req, res) => {
  res.json({
    activeJob: active,
    queued: queue.length,
    jobs: [...jobs.values()].map(view).reverse(),
  });
});

app.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job id' });
  res.json(view(job));
});

// The ASINs from this job that still have no settled outcome. Feed straight back
// into POST /jobs: already-scraped ASINs are skipped, so a resubmit only costs
// the work that is genuinely outstanding.
app.get('/jobs/:id/retry.csv', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).type('text/plain').send('unknown job id');
  const f = retryPath(job.id);
  if (!fs.existsSync(f)) {
    return res.status(404).type('text/plain').send('nothing to retry for this job');
  }
  res.type('text/csv').set('Content-Disposition', `attachment; filename="retry-${job.id.slice(0, 8)}.csv"`);
  res.send(fs.readFileSync(f, 'utf8'));
});

// Ask a running job to stop after the ASIN in flight. Rows already written stay
// written, and a re-upload of the same list skips nothing -- the upsert key makes
// a repeat safe.
app.post('/jobs/:id/stop', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job id' });
  if (view(job).completed) return res.status(409).json({ error: `job already ${job.state}` });
  job._stop = true;
  res.json({ jobId: job.id, stopping: true });
});

restore();
// restore() only fills the queue -- without this, a re-queued job waits for an
// unrelated upload or completion to trigger the pump, which may never arrive.
pump();

const port = Number(process.env.PORT || 8090);

// Which interface to listen on. DEFAULT IS LOOPBACK ONLY.
//
// This service has no authentication, and every meaningful endpoint is a write:
// POST /jobs starts a job that writes to a shared database, /backlog.csv hands
// over the ASIN list, POST /jobs/:id/stop kills a running sweep. On a VM with a
// public address and no firewall rule, binding 0.0.0.0 publishes all of that to
// anyone who scans the IP -- and cloud address ranges are scanned continuously.
//
// SSH credentials are not a substitute: they gate shell access, not an open TCP
// port. Binding to loopback is what actually makes them the boundary, because
// the only way in is then through a tunnel:
//
//   ssh -L 8090:localhost:8090 <user>@<vm>
//   # then open http://localhost:8090 on your own machine
//
// No auth code, no IAP, no firewall rule, and the people who hold the VM
// credentials are exactly the people who can reach the UI.
//
// Set BIND_HOST=0.0.0.0 to override. Do that only behind a firewall that
// restricts port 8090, and never on a box with a public address.
const bindHost = process.env.BIND_HOST || '127.0.0.1';
const server = app.listen(port, bindHost, () => {
  const t = dbTarget();
  console.log(`helium10 panel scraper listening on ${bindHost}:${port}`);
  if (bindHost === '127.0.0.1' || bindHost === 'localhost') {
    console.log(`  loopback only — reach it with:  ssh -L ${port}:localhost:${port} <user>@<host>`);
  } else {
    console.log(`  WARNING: bound to ${bindHost} with NO AUTHENTICATION.`);
    console.log(`  Anyone who can reach ${bindHost}:${port} can start jobs that write to the database.`);
  }
  console.log(
    `  MODE=${t.mode.toUpperCase()} -> writes to ${t.database} on ${t.host} ` +
    `(tables ${t.tablePrefix}helium_product_research*)`,
  );
  if (t.mode !== 'staging') {
    console.log('  this is NOT the shared staging database');
  }
  console.log(`  http://localhost:${port}/            upload form`);
  console.log(`  http://localhost:${port}/status.html job status`);
  console.log(`  POST /jobs          upload a CSV of ASINs`);
  console.log(`  GET  /jobs/:id      job status`);
  console.log(`  GET  /jobs          all jobs`);
  console.log(`  POST /jobs/:id/stop stop a running job`);
  console.log(`  GET  /health        db connectivity`);
  console.log(`  GET  /backlog       outstanding count, derived from the DB`);
  console.log(`  GET  /backlog.csv   that list as CSV, to upload if you choose`);
  console.log(
    notifyConfigured()
      ? `  alerts -> Zoho Cliq (idle warning after ${IDLE_ALERT_HOURS}h with backlog outstanding)`
      : `  alerts -> DISABLED (CLIQ_WEBHOOK_URL is not set)`,
  );
  // Announce the boot. On a box that is expected to grind for days, an
  // unexplained restart is a signal in itself -- and it doubles as proof the
  // webhook still works from this host's egress IP, which is the one thing no
  // amount of local testing can establish.
  notifyStartup({ port }).catch(() => {});
});

// Unref'd so the interval can never be the reason the process refuses to exit.
const idleTimer = setInterval(() => { idleCheck().catch(() => {}); }, IDLE_CHECK_MS);
idleTimer.unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n${sig} -- shutting down`);
    if (active) jobs.get(active)._stop = true;
    clearInterval(idleTimer);
    server.close();
    await getPool().end().catch(() => {});
    process.exit(0);
  });
}
