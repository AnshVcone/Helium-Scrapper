import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root: ROOT,
  profileDir: path.join(ROOT, 'profile'),

  // The extension version this extractor was written against. Panel markup has
  // already moved once (8.42.1 -> 8.42.2 in nine days). The extension
  // self-updates, so this is checked at runtime off the panel footer; a
  // mismatch is a reason to re-run `npm run probe`, not to keep scraping.
  expectedExtensionVersion: '8.42.2',

  marketplace: 'https://www.amazon.com',

  inputFile: path.join(ROOT, 'input', 'asins.txt'),

  // Pacing. Measured page-load + panel round trip was 4-9s per ASIN, so the
  // floor here is not the bottleneck -- Amazon's tolerance is.
  delayMs: [4000, 9000],
  // Be patient. Getting no reading is acceptable; recording a wrong one is not,
  // so every wait here is generous rather than tight.
  panelTimeoutMs: Number(process.env.PANEL_TIMEOUT_MS || 90000),

  // A figure is only trusted once it has stopped changing. The panel can paint
  // an interim value (notably $0) before the real one arrives, so a single read
  // is not evidence -- two identical reads this far apart are.
  valueStabilityMs: Number(process.env.VALUE_STABILITY_MS || 2500),
  // How many consecutive identical samples are required.
  valueStabilitySamples: Number(process.env.VALUE_STABILITY_SAMPLES || 2),

  // Abort rather than write a column of nulls. If the panel renders but we
  // cannot find the tiles, the markup changed and every subsequent row is junk.
  maxConsecutiveUnknownShape: 3,
  maxConsecutiveBlocked: 3,

  // A throttled IP does not always produce a CAPTCHA. Amazon often serves a
  // degraded page instead: the product renders but the Helium 10 panel never
  // populates, which reads as TIMEOUT. So a climbing TIMEOUT rate is the earlier
  // signal that an IP is being squeezed, and without a threshold here a
  // throttled server would grind through an entire sheet producing nothing.
  maxConsecutiveTimeouts: Number(process.env.MAX_CONSECUTIVE_TIMEOUTS || 6),

  // Warn before giving up. The abort above is the right place to *stop*, but it
  // is the wrong place to first *tell* someone: by then the run is already over
  // and the box is idle. At this many consecutive timeouts the run continues --
  // it may still recover -- but an alert goes out, so a squeeze on a multi-day
  // sweep is visible while there is still something to decide.
  throttleWarnAt: Number(process.env.THROTTLE_WARN_AT || 3),

  // How long a settled answer suppresses a re-scrape.
  //
  // Two failure modes bracket this number. Too short (the original 'settled
  // today') and every resume re-scrapes work already paid for, because a large
  // sheet cannot finish inside one UTC day. Too long ('settled ever') and an
  // ASIN is retired permanently -- but the panel reports a *30-day trailing*
  // revenue, so the answer genuinely goes stale and must eventually be asked
  // again.
  //
  // 2 means today and yesterday: long enough that a run interrupted overnight
  // resumes for free, short enough that nothing is retired. Raise it if you
  // find yourself re-scraping sheets you did not mean to refresh.
  skipIfSettledWithinDays: Number(process.env.SKIP_IF_SETTLED_WITHIN_DAYS || 2),

  // Requesting a helium10.com page mid-run to stop the session idling out.
  //
  // DEFAULT OFF, because it made things worse. Measured, same 545-ASIN sheet:
  //   off, others logged in : 126 ASINs / 31.9 min
  //   off, others logged in :  16 ASINs /  6.0 min
  //   off, nobody else      : 106 ASINs / 28.6 min
  //   ON                    :  23 ASINs /  9.0 min   <-- worst by far
  //
  // And the ordering was explicit: `keep-alive ok at 23 ASINs` was the last log
  // line before the abort. The tab reported a healthy session and the very next
  // ASIN found the panel signed out. The likeliest reading is that loading the
  // dashboard registered a session of its own and evicted the extension's --
  // the tab sees the new one and reports success while the panel loses the old.
  //
  // Left in, at 0, because the measurement is worth keeping and because an idle
  // timeout is still not ruled out -- only this way of preventing it is.
  keepAliveMs: Number(process.env.SESSION_KEEPALIVE_MS || 0),
};

export const rand = ([lo, hi]) => lo + Math.floor(Math.random() * (hi - lo));
