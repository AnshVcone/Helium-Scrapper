import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { loadEnv, ping, getPool, writeMissing, MissingReason,
         backlogAsins, backlogCount } from './db.js';
import { runJob, parseAsins } from './runner.js';

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
  const { _asins, _stop, _retryAsins, _retryDetail, ...rest } = job;
  // Skipped ASINs are resolved work, so they count toward completion -- without
  // this the bar would stall below 100% on any re-upload.
  const accounted = rest.processed + rest.skipped;
  const remaining = Math.max(0, rest.total - accounted);
  return {
    ...rest,
    remaining,
    percent: rest.total ? Math.round((accounted / rest.total) * 100) : 0,
    completed: ['completed', 'failed', 'stopped'].includes(rest.state),
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
      state: job._stop ? 'stopped' : 'completed',
    });
  } catch (err) {
    job.state = 'failed';
    job.error = String(err.message || err).slice(0, 500);
    console.error(`[server] job ${job.id} failed:`, err);
  } finally {
    job.finishedAt = new Date().toISOString();
    const outstanding = job._retryAsins || [];
    // The ASIN list is the bulk of the memory; drop it once the job is done.
    job._asins = [];
    active = null;

    // No automatic retry. An ASIN we could not read is recorded in the missing
    // table and re-offered by /backlog, so the next upload or backlog run picks
    // it up. Retrying inline would re-walk the same pages in the same
    // conditions -- on a large sheet that is hours spent re-failing.
    if (outstanding.length && job.state !== 'stopped') {
      const detail = job._retryDetail || {};
      const entries = outstanding.map((asin) => ({
        asin,
        reason: MissingReason.UNRESOLVED,
        errorCode: detail[asin] || 'UNKNOWN',
        errorMessage: `no reading this run; last outcome ${detail[asin] || 'unknown'}`,
      }));
      try {
        const n = await writeMissing(entries, job.marketplace, job.fetchDate);
        job.insertedMissing += n;
        job.unresolvedWritten = n;
        console.log(
          `[server] ${outstanding.length} ASIN(s) unresolved; wrote ${n} as ` +
          `${MissingReason.UNRESOLVED} (re-offered by /backlog, not retried inline)`,
        );
      } catch (e) {
        console.error('[server] could not record unresolved ASINs:', e.message);
      }
    }

    persist();
    pump();
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', async (_req, res) => {
  try {
    const info = await ping();
    res.json({ ok: true, db: info.db, user: info.usr, activeJob: active });
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
  const fetchDate = new Date().toISOString().slice(0, 10);
  try {
    const counts = await backlogCount({ marketplace, fetchDate });
    res.json({ marketplace, fetchDate, ...counts });
  } catch (err) {
    res.status(503).json({ error: String(err.message || err) });
  }
});

// Same set as a CSV, ready to feed straight back into POST /jobs.
app.get('/backlog.csv', async (req, res) => {
  const marketplace = (req.query.marketplace || 'US').toString().toUpperCase();
  const limit = Math.min(Number(req.query.limit) || 1000, 200000);
  const fetchDate = new Date().toISOString().slice(0, 10);
  try {
    const asins = await backlogAsins({ marketplace, fetchDate, limit });
    res.type('text/csv')
       .set('Content-Disposition', `attachment; filename="backlog-${fetchDate}.csv"`)
       .send(asins.join('\n') + (asins.length ? '\n' : ''));
  } catch (err) {
    res.status(503).type('text/plain').send(String(err.message || err));
  }
});

// One call to start working the backlog -- no download, no upload.
//   curl -X POST 'localhost:8090/jobs/from-backlog?limit=500'
app.post('/jobs/from-backlog', async (req, res) => {
  const marketplace = (req.query.marketplace || 'US').toString().toUpperCase();
  const limit = Math.min(Number(req.query.limit) || 500, 200000);
  const fetchDate = new Date().toISOString().slice(0, 10);
  try {
    const asins = await backlogAsins({ marketplace, fetchDate, limit });
    if (!asins.length) {
      return res.status(200).json({ accepted: 0, message: 'backlog is empty for today' });
    }
    const job = newJob({ asins, marketplace, filename: `backlog-${fetchDate}` });
    res.status(202).json({
      jobId: job.id,
      accepted: asins.length,
      state: job.state,
      statusUrl: `/jobs/${job.id}`,
    });
  } catch (err) {
    res.status(503).json({ error: String(err.message || err) });
  }
});

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
const server = app.listen(port, () => {
  console.log(`helium10 panel scraper listening on :${port}`);
  console.log(`  http://localhost:${port}/            upload form`);
  console.log(`  http://localhost:${port}/status.html job status`);
  console.log(`  POST /jobs          upload a CSV of ASINs`);
  console.log(`  GET  /jobs/:id      job status`);
  console.log(`  GET  /jobs          all jobs`);
  console.log(`  POST /jobs/:id/stop stop a running job`);
  console.log(`  GET  /health        db connectivity`);
  console.log(`  GET  /backlog       outstanding count, derived from the DB`);
  console.log(`  GET  /backlog.csv   that list as CSV`);
  console.log(`  POST /jobs/from-backlog?limit=N   scrape it directly`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n${sig} -- shutting down`);
    if (active) jobs.get(active)._stop = true;
    server.close();
    await getPool().end().catch(() => {});
    process.exit(0);
  });
}
