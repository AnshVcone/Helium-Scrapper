import { openBrowser, getPage } from './chrome.js';
import { config, rand } from './config.js';
import { extractPanel, Status } from './extract.js';
import { login, getCreds, explain, Auth } from './auth.js';
import { checkPanelVersion } from './browser.js';
import { writeFound, writeMissing, MissingReason, existingKeys } from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How a panel outcome maps onto the two tables.
//
// Only outcomes that are *facts about the product* become rows. Transient
// failures and bugs (timeout, bot wall, unrecognised markup, lost browser) are
// deliberately NOT written to the missing table: that table means "Helium 10 has
// no data for this ASIN", and recording a timeout there would permanently mark a
// product as dataless because our run broke. Those ASINs stay unwritten so a
// re-run picks them up again.
const TERMINAL = {
  [Status.OK]: 'found',
  [Status.NO_DATA]: MissingReason.NO_DATA,
  [Status.REDIRECTED]: MissingReason.REDIRECTED,
  [Status.DEAD]: MissingReason.DEAD,
};

const FLUSH_EVERY = 25;

export async function runJob({
  asins,
  marketplace = 'US',
  fetchDate = new Date().toISOString().slice(0, 10),
  onProgress = () => {},
  shouldStop = () => false,
  writeDb = true,
  skipExisting = true,
} = {}) {
  const summary = {
    total: asins.length,
    skipped: 0,
    processed: 0,
    found: 0,
    missing: 0,
    errors: 0,
    insertedFound: 0,
    insertedMissing: 0,
    byStatus: {},
    aborted: null,
    marketplace,
    fetchDate,
    writeDb,
    // ASINs with no settled outcome after this run: transient failures plus
    // anything an abort never reached. This is the list to re-submit.
    retryAsins: [],
    // asin -> last status seen, so a give-up row can say what kept failing.
    retryDetail: {},
  };

  // Skip ASINs that already have a settled row for this marketplace and date.
  // Two CSVs sharing an ASIN, or a re-upload after an abort, would otherwise
  // re-scrape it -- paying a page load and Amazon-facing request to overwrite a
  // row with the same value. Transient failures are never written, so they are
  // absent here and get retried automatically.
  let queue = asins;
  if (skipExisting && writeDb) {
    try {
      const done = await existingKeys(asins, marketplace, fetchDate);
      if (done.size) {
        queue = asins.filter((a) => !done.has(a));
        summary.skipped = asins.length - queue.length;
        console.log(`[runner] skipping ${summary.skipped} ASIN(s) already scraped for ${fetchDate}`);
      }
    } catch (e) {
      console.error('[runner] skip-existing lookup failed, scraping everything:', e.message);
    }
  }

  const settled = new Set();
  const lastStatus = new Map();

  // Nothing to do: skip the Chromium launch entirely rather than starting a
  // browser to process an empty queue.
  if (!queue.length) {
    onProgress({ ...summary, current: null, lastStatus: null });
    return summary;
  }

  const { ctx } = await openBrowser();
  const page = await getPage(ctx);

  let foundBuf = [];
  let missingBuf = [];
  let unknownShape = 0;
  let blocked = 0;
  let timeouts = 0;
  let reloginAttempts = 0;
  let versionChecked = false;
  // Once a panel has rendered in this run, the extension is demonstrably
  // installed and working.
  let panelEverSeen = false;

  const flush = async () => {
    if (foundBuf.length) {
      // A dry run still counts what it would have written, so a CLI check
      // reports the same numbers the real job would.
      summary.insertedFound += writeDb
        ? await writeFound(foundBuf, marketplace, fetchDate)
        : foundBuf.length;
      foundBuf = [];
    }
    if (missingBuf.length) {
      summary.insertedMissing += writeDb
        ? await writeMissing(missingBuf, marketplace, fetchDate)
        : missingBuf.length;
      missingBuf = [];
    }
  };

  try {
    for (let i = 0; i < queue.length; i++) {
      if (shouldStop()) {
        summary.aborted = 'stopped by request';
        break;
      }

      const asin = queue[i];
      const t0 = Date.now();
      let r;

      try {
        await page.goto(`${config.marketplace}/dp/${asin}`, {
          waitUntil: 'domcontentloaded',
          timeout: config.panelTimeoutMs,
        });
        r = await extractPanel(page, asin, config.panelTimeoutMs);
      } catch (err) {
        const msg = String(err.message || err);
        const gone = /has been closed|Target closed|browser has disconnected|WebSocket/i.test(msg);
        r = { status: gone ? Status.DISCONNECTED : Status.TIMEOUT, error: msg.slice(0, 300) };
      }

      r.asin = asin;
      r.scrapedAt = new Date().toISOString();
      r.ms = Date.now() - t0;

      if ([Status.OK, Status.NO_DATA, Status.SHAPE_UNKNOWN].includes(r.status)) {
        panelEverSeen = true;
      }

      // A missing launcher is only evidence of a missing extension on the first
      // page. After a panel has already rendered this run, it means this one
      // page did not paint -- transient, and retryable. Treating it as fatal
      // aborted a 19-ASIN run at 18 with 6 results already in hand.
      if (r.status === Status.EXTENSION_MISSING && panelEverSeen) {
        r.status = Status.TIMEOUT;
        r.note = 'launcher not found on this page; extension is loaded (panel seen earlier this run)';
      }

      // Re-authenticate before any counting. This attempt is not an outcome for
      // the ASIN -- it gets retried -- so counting it here inflated `processed`
      // past `total` and pushed percent over 100.
      if (r.status === Status.NOT_LOGGED_IN && reloginAttempts < 2 && getCreds()) {
        reloginAttempts++;
        summary.relogins = reloginAttempts;
        const auth = await login(page);
        if (auth.status === Auth.OK || auth.status === Auth.ALREADY) {
          i--; // retry the same ASIN, uncounted
          continue;
        }
        summary.aborted = explain(auth.status);
        break;
      }

      summary.byStatus[r.status] = (summary.byStatus[r.status] || 0) + 1;
      lastStatus.set(asin, r.status);

      if (r.extensionVersion && !versionChecked) {
        versionChecked = true;
        const v = checkPanelVersion(r.extensionVersion);
        if (!v.ok) console.warn(`[runner] WARNING: ${v.note}`);
      }

      // Route the outcome.
      const route = TERMINAL[r.status];
      if (route === 'found') {
        foundBuf.push(r);
        settled.add(asin);
        summary.found++;
      } else if (route) {
        missingBuf.push({
          asin,
          reason: route,
          errorCode: r.status === Status.REDIRECTED ? 'served_other_asin' : null,
          errorMessage:
            r.status === Status.REDIRECTED
              ? `Amazon served ${r.onPageAsin || r.panelAsin || 'a different ASIN'}`
              : null,
        });
        settled.add(asin);
        summary.missing++;
      } else {
        summary.errors++;
      }

      summary.processed++;
      onProgress({ ...summary, current: asin, lastStatus: r.status });

      if (foundBuf.length + missingBuf.length >= FLUSH_EVERY) await flush();

      // --- abort / recovery conditions ---

      if (r.status === Status.DISCONNECTED) {
        summary.aborted = 'browser died mid-run; re-run to retry the remainder';
        break;
      }

      if (r.status === Status.EXTENSION_MISSING) {
        summary.aborted = 'extension not loaded; run `npm run fetch-ext`';
        break;
      }

      // Reaching here with NOT_LOGGED_IN means the relogin path above was
      // exhausted or unavailable.
      if (r.status === Status.NOT_LOGGED_IN) {
        summary.aborted = getCreds()
          ? 'signed out repeatedly after re-authenticating'
          : explain(Auth.NO_CREDS);
        break;
      }

      if (r.status === Status.SHAPE_UNKNOWN) {
        unknownShape++;
        if (unknownShape >= config.maxConsecutiveUnknownShape) {
          summary.aborted =
            'panel markup unrecognised repeatedly; re-run `npm run probe` and fix src/extract.js';
          break;
        }
      } else {
        unknownShape = 0;
      }

      // Consecutive timeouts almost certainly mean throttling rather than a run
      // of slow pages -- a healthy IP does not fail six pages in a row.
      if (r.status === Status.TIMEOUT) {
        timeouts++;
        if (timeouts >= config.maxConsecutiveTimeouts) {
          summary.aborted =
            `${timeouts} consecutive timeouts -- the panel is not populating. ` +
            `This is what a throttled IP usually looks like rather than a CAPTCHA. ` +
            `Stopped before burning the rest of the sheet; remaining ASINs are unwritten ` +
            `and will be retried.`;
          summary.throttleSuspected = true;
          break;
        }
      } else {
        timeouts = 0;
      }

      if (r.status === Status.BLOCKED) {
        blocked++;
        if (blocked >= config.maxConsecutiveBlocked) {
          summary.aborted = 'Amazon is serving bot walls; stopped';
          break;
        }
        await sleep(60000 * blocked);
      } else {
        blocked = 0;
      }

      if (i < queue.length - 1) await sleep(rand(config.delayMs));
    }

    await flush();
  } finally {
    // Everything queued that did not reach a settled outcome -- errors and, if
    // the run aborted, the ASINs it never got to.
    summary.retryAsins = queue.filter((a) => !settled.has(a));
    for (const a of summary.retryAsins) {
      summary.retryDetail[a] = lastStatus.get(a) || 'NEVER_ATTEMPTED';
    }
    await flush().catch((e) => console.error('[runner] final flush failed:', e.message));
    await ctx.close().catch(() => {});
  }

  return summary;
}

// Accepts a raw CSV/TXT body and returns the ASINs in it. Mirrors the Go
// sync's PartitionASINs: a header row or stray word must never reach the
// scraper as a fake ASIN.
export function parseAsins(text) {
  const tokens = String(text)
    .split(/[\s,;]+/)
    .map((t) => t.trim().replace(/^["']|["']$/g, '').toUpperCase())
    .filter(Boolean);

  const valid = [];
  const rejected = [];
  const seen = new Set();
  for (const t of tokens) {
    // Amazon ASINs are 10 chars, alphanumeric, and always contain a digit --
    // that last part is what rejects header words like "PARENTASIN".
    if (/^[A-Z0-9]{10}$/.test(t) && /\d/.test(t)) {
      if (!seen.has(t)) {
        seen.add(t);
        valid.push(t);
      }
    } else {
      rejected.push(t);
    }
  }
  return { asins: valid, rejected };
}
