import { openBrowser, getPage } from './chrome.js';
import { config, rand } from './config.js';
import { extractPanel, Status } from './extract.js';
import { login, isLoggedIn, touchSession, getCreds, explain, Auth } from './auth.js';
import { checkPanelVersion } from './browser.js';
import { writeFound, writeMissing, MissingReason, NoDataCode, existingKeys } from './db.js';
import { browseLikeAHuman, shouldTakeLongBreak, scheduleNextBreak } from './behave.js';
import { Event } from './notify.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How a panel outcome maps onto the two tables.
//
// Only outcomes that are *facts about the product* become rows. Transient
// failures and bugs (timeout, bot wall, unrecognised markup, lost browser) are
// deliberately NOT written to the missing table: that table means "Helium 10 has
// no data for this ASIN", and recording a timeout there would permanently mark a
// product as dataless because our run broke. Those ASINs stay unwritten so a
// re-run picks them up again.
// All three settled misses answer the retry question identically -- there is no
// data for this ASIN and another attempt will not change that -- so they share
// one reason and are told apart by error_code.
const TERMINAL = {
  [Status.OK]: 'found',
  [Status.NO_DATA]: NoDataCode.NO_ESTIMATE,
  [Status.REDIRECTED]: NoDataCode.SERVED_OTHER_ASIN,
  [Status.DEAD]: NoDataCode.ASIN_DEAD,
};

const FLUSH_EVERY = 25;

export async function runJob({
  asins,
  marketplace = 'US',
  fetchDate = new Date().toISOString().slice(0, 10),
  onProgress = () => {},
  // Out-of-band conditions worth waking a human for: throttling, bot walls,
  // changed markup, a lost session. Kept as a callback rather than calling the
  // notifier directly so the runner stays unaware of how -- or whether --
  // anything is delivered, and a CLI run stays silent by default.
  onEvent = () => {},
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

  // Rule 1 of alerting: it must never be able to break a scrape. A throwing or
  // slow handler is the caller's problem, not this loop's.
  const emit = (event, detail) => {
    try {
      onEvent(event, { detail, processed: summary.processed, total: summary.total });
    } catch (e) {
      console.error(`[runner] onEvent(${event}) threw:`, e.message);
    }
  };

  // Skip ASINs that already have a settled row for this marketplace and date.
  // Two CSVs sharing an ASIN, or a re-upload after an abort, would otherwise
  // re-scrape it -- paying a page load and Amazon-facing request to overwrite a
  // row with the same value. Transient failures are never written, so they are
  // absent here and get retried automatically.
  let queue = asins;
  if (skipExisting && writeDb) {
    // Retry, then ABORT -- never fall back to scraping everything.
    //
    // "Scrape everything" was the original fallback and it is actively harmful:
    // a signed-in session lasts about 30 minutes, so the scarce resource is
    // session time, not ASINs. A transient DB blip once sent a run to re-read
    // 265 ASINs that were already settled, spending most of a session to
    // overwrite rows with the same values. Failing loudly costs one upload;
    // scraping everything costs the whole session.
    //
    // The failure seen in practice is "Connection terminated due to connection
    // timeout" -- the pool could not get a connection to the staging host over
    // the public internet, not a slow query. That clears in seconds, so a short
    // retry is almost always enough.
    let done = null;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try {
        done = await existingKeys(asins, marketplace);
      } catch (e) {
        console.error(
          `[runner] skip-existing lookup failed (attempt ${attempt}/3): ${e.message}`,
        );
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }

    if (!done) {
      summary.aborted =
        'could not read the ledger of already-scraped ASINs after 3 attempts, so ' +
        'the run stopped rather than re-scrape work already done. Nothing was ' +
        'written; re-upload the same CSV once the database is reachable.';
      onProgress({ ...summary, current: null, lastStatus: null });
      emit(Event.LEDGER_UNREADABLE, summary.aborted);
      return summary;
    }

    if (done.size) {
      queue = asins.filter((a) => !done.has(a));
      summary.skipped = asins.length - queue.length;
      console.log(
        `[runner] skipping ${summary.skipped} ASIN(s) settled within the last ` +
        `${config.skipIfSettledWithinDays} day(s)`,
      );
    }
  }

  const settled = new Set();
  const lastStatus = new Map();
  // Attempted != queued. A run that aborts at 2,000 of 5,000 never touched the
  // remaining 3,000, and recording those as panel_unresolved says we tried and
  // failed on pages we never opened. Harmless only while unresolved is
  // retryable; a lie in the data either way.
  const attempted = new Set();

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
  // Bounds the false-logout re-read below. Without a cap, a panel that
  // permanently disagrees with a live session would spin on one ASIN forever.
  const falseLogoutsByAsin = new Map();
  // Last time helium10.com was requested. Starts now: the session was just
  // established, so it does not need touching on the first ASIN.
  let lastTouch = Date.now();
  // First long break lands after a random number of ASINs, so two servers
  // started together do not pause in lockstep.
  let nextBreakAt = scheduleNextBreak(0, config.longBreakEvery);
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
      attempted.add(asin);
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
      //
      // But NEVER re-login on the panel's word alone. `login()` submits the
      // sign-in form, and a submission that runs into a CAPTCHA *destroys the
      // existing session cookie*. The panel reports its logged-out state while
      // the MV3 service worker is still cold-starting, so a first-page reading
      // is not evidence -- and trusting it cost a valid `_identity` cookie
      // (good for another month) thirty seconds into a 548-ASIN run.
      //
      // `isLoggedIn()` only navigates, so it is safe to ask. Same shape as the
      // EXTENSION_MISSING guard below: transient on the first page, real later.
      if (r.status === Status.NOT_LOGGED_IN && getCreds()) {
        // Ask the site, not the panel. This navigates and reads the redirect;
        // it submits nothing, so it cannot cost us a cookie.
        const sessionLive = await isLoggedIn(page);
        const seen = falseLogoutsByAsin.get(asin) || 0;

        if (sessionLive) {
          // The panel lied. Never touch the login form in this branch.
          if (seen < 2) {
            falseLogoutsByAsin.set(asin, seen + 1);
            summary.falseLogouts = (summary.falseLogouts || 0) + 1;
            console.log(
              `[runner] panel said logged out but the session is live; ` +
              `re-reading ${asin} (attempt ${seen + 2})`,
            );
            i--;
            continue;
          }
          // Three logged-out readings against a live session is a bad page, not
          // a bad session. Record it as unread and move on -- the ASIN comes
          // back on a later run.
          r.status = Status.TIMEOUT;
          r.note = `panel reported logged out ${seen + 1}x while the session was live`;
          console.warn(`[runner] ${asin}: ${r.note}; recording as unread`);
        } else if (reloginAttempts < 2) {
          // Genuinely signed out. This is the only path allowed to submit the
          // form, and only after the check above has confirmed the need.
          reloginAttempts++;
          summary.relogins = reloginAttempts;
          const auth = await login(page);
          if (auth.status === Auth.OK || auth.status === Auth.ALREADY) {
            i--; // retry the same ASIN, uncounted
            continue;
          }
          // Re-login itself failed. This path breaks out well before the
          // NOT_LOGGED_IN handler further down, so without its own emit a dead
          // shared account would stop the sweep in silence -- and without the
          // lastStatus write, this ASIN would be filed as a timeout when what
          // actually happened was a lost session.
          lastStatus.set(asin, r.status);
          summary.aborted = explain(auth.status);
          emit(Event.LOGGED_OUT, `re-login ${reloginAttempts} failed: ${summary.aborted}`);
          break;
        }
      }

      summary.byStatus[r.status] = (summary.byStatus[r.status] || 0) + 1;
      lastStatus.set(asin, r.status);

      if (r.extensionVersion && !versionChecked) {
        versionChecked = true;
        const v = checkPanelVersion(r.extensionVersion);
        if (!v.ok) {
          console.warn(`[runner] WARNING: ${v.note}`);
          emit(Event.VERSION_MISMATCH, v.note);
        }
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
          reason: MissingReason.NO_DATA,
          errorCode: route,
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

      // Flush BEFORE reporting progress. The other way round, `inserted` always
      // lagged a row behind and read 0 for the whole first batch of 25 -- which
      // looks exactly like data being dropped.
      if (foundBuf.length + missingBuf.length >= FLUSH_EVERY) await flush();

      onProgress({ ...summary, current: asin, lastStatus: r.status });

      // --- abort / recovery conditions ---

      if (r.status === Status.DISCONNECTED) {
        summary.aborted = 'browser died mid-run; re-run to retry the remainder';
        emit(Event.BROWSER_DIED, r.error || null);
        break;
      }

      if (r.status === Status.EXTENSION_MISSING) {
        summary.aborted = 'extension not loaded; run `npm run fetch-ext`';
        emit(Event.EXTENSION_MISSING, 'no panel launcher on the first page');
        break;
      }

      // Reaching here with NOT_LOGGED_IN means the relogin path above was
      // exhausted or unavailable.
      if (r.status === Status.NOT_LOGGED_IN) {
        summary.aborted = getCreds()
          ? 'signed out repeatedly after re-authenticating'
          : explain(Auth.NO_CREDS);
        emit(Event.LOGGED_OUT, summary.aborted);
        break;
      }

      if (r.status === Status.SHAPE_UNKNOWN) {
        unknownShape++;
        if (unknownShape >= config.maxConsecutiveUnknownShape) {
          summary.aborted =
            'panel markup unrecognised repeatedly; re-run `npm run probe` and fix src/extract.js';
          emit(
            Event.MARKUP_CHANGED,
            `${unknownShape} pages unparsed` + (r.extensionVersion ? `, panel v${r.extensionVersion}` : ''),
          );
          break;
        }
      } else {
        unknownShape = 0;
      }

      // Consecutive timeouts almost certainly mean throttling rather than a run
      // of slow pages -- a healthy IP does not fail six pages in a row.
      if (r.status === Status.TIMEOUT) {
        timeouts++;
        // Warn on the way up, once. The run keeps going -- a short bad patch does
        // recover -- but nobody has to be watching /status.html to learn about it.
        if (timeouts === config.throttleWarnAt) {
          emit(Event.THROTTLE_WARNING, `${timeouts} timeouts in a row, stops at ${config.maxConsecutiveTimeouts}`);
        }
        if (timeouts >= config.maxConsecutiveTimeouts) {
          summary.aborted =
            `${timeouts} consecutive timeouts -- the panel is not populating. ` +
            `This is what a throttled IP usually looks like rather than a CAPTCHA. ` +
            `Stopped before burning the rest of the sheet; remaining ASINs are unwritten ` +
            `and will be retried.`;
          summary.throttleSuspected = true;
          emit(Event.THROTTLE_ABORT, `${timeouts} timeouts in a row, ${queue.length - (i + 1)} left unwritten`);
          break;
        }
      } else {
        timeouts = 0;
      }

      if (r.status === Status.BLOCKED) {
        blocked++;
        if (blocked >= config.maxConsecutiveBlocked) {
          summary.aborted = 'Amazon is serving bot walls; stopped';
          emit(Event.BOT_WALL, `${blocked} CAPTCHA pages, ${queue.length - (i + 1)} left unwritten`);
          break;
        }
        await sleep(60000 * blocked);
      } else {
        blocked = 0;
      }

      // Keep the H10 session from idling out. Between ASINs only, never
      // mid-extraction, and only every keepAliveMs -- one extra page load per
      // 8 minutes against ~30 ASINs is a rounding error on the run time.
      if (config.keepAliveMs > 0 && Date.now() - lastTouch >= config.keepAliveMs) {
        lastTouch = Date.now();
        const t = await touchSession(ctx);
        summary.sessionTouches = (summary.sessionTouches || 0) + 1;
        if (t.alive === false) {
          // Early warning: the site has already signed us out, so the next ASIN
          // was going to discover it the hard way.
          console.warn('[runner] keep-alive: H10 has signed us out');
          summary.sessionLostAt = summary.processed;
        } else if (t.error) {
          console.warn(`[runner] keep-alive failed (harmless): ${t.error}`);
        } else {
          console.log(`[runner] keep-alive ok at ${summary.processed} ASINs`);
        }
      }

      if (i < queue.length - 1) {
        // The inter-ASIN gap, spent on the page rather than on a frozen one.
        // Same duration either way -- this is not a slowdown, it is the same
        // wait with scrolling and cursor movement in it instead of nothing.
        //
        // Deliberately after the row is recorded: the extractor waits for the
        // panel's figures to stop changing, and scrolling inside that window
        // would risk a wrong reading for the sake of looking busy.
        const gap = rand(config.delayMs);
        if (config.humanize) await browseLikeAHuman(page, gap);
        else await sleep(gap);

        // Occasional longer pause, so the traffic is not a metronome.
        if (
          config.longBreakEvery[0] > 0 &&
          shouldTakeLongBreak(summary.processed, nextBreakAt)
        ) {
          const restMs = rand(config.longBreakMs);
          nextBreakAt = scheduleNextBreak(summary.processed, config.longBreakEvery);
          summary.longBreaks = (summary.longBreaks || 0) + 1;
          console.log(
            `[runner] pausing ${Math.round(restMs / 1000)}s after ${summary.processed} ` +
            `ASINs (next break at ~${nextBreakAt})`,
          );
          // Honour a stop request during the break rather than making someone
          // wait out five minutes of nothing.
          const until = Date.now() + restMs;
          while (Date.now() < until && !shouldStop()) await sleep(1000);
        }
      }
    }

    await flush();
  } finally {
    // Everything queued that did not reach a settled outcome -- errors and, if
    // the run aborted, the ASINs it never got to.
    // Everything unsettled comes back, but the two kinds are kept apart so the
    // caller can record them honestly: one was read and failed, the other was
    // never opened.
    summary.retryAsins = queue.filter((a) => !settled.has(a));
    summary.attemptedAsins = summary.retryAsins.filter((a) => attempted.has(a));
    summary.neverAttemptedAsins = summary.retryAsins.filter((a) => !attempted.has(a));
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
