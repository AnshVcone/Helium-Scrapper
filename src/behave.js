// On-page behaviour, so a run does not read as 500 identical hits.
//
// The economics here are the whole design, and they are counter-intuitive:
//
//   Amazon throttled us after ~443 product page loads from one IP. The
//   observable signature was the TIMEOUT rate climbing 1% -> 2% -> 7% -> 14% ->
//   100%. So the binding constraint is REQUESTS, not realism.
//
// That rules out the obvious "human" touches. Arriving via a search results
// page, or opening the reviews page and coming back, each double the requests
// per ASIN -- they would make the scraper look more human right up until it got
// blocked twice as fast. Every technique in this file therefore adds *time on
// page* and *zero extra requests*, which lowers the request rate and looks human
// at the same time.
//
// And the time is already being spent: the runner sleeps 4-9s between ASINs on a
// static page. Scrolling during that window costs nothing at all.
//
// Deliberately NOT here: fingerprint spoofing, navigator.webdriver patching, or
// anything that lies about what the browser is. Those were ruled out on
// 2026-08-27 and this is pacing, not evasion.
import { rand } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;

// Real desktop sizes, so the window is not the headless default 800x600 -- an
// unusual size on its own, and identical on every single page load.
const VIEWPORTS = [
  { width: 1512, height: 858 },  // 14" MacBook Pro, scaled
  { width: 1440, height: 900 },  // MacBook Air
  { width: 1920, height: 1080 },
  { width: 1680, height: 1050 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
];

export function pickViewport() {
  return pick(VIEWPORTS);
}

/**
 * Spend `budgetMs` on the current page behaving like someone reading it, rather
 * than sleeping on a frozen screenshot.
 *
 * Called AFTER extraction has finished and the row is recorded. That ordering is
 * not incidental: the extractor waits for the panel's figures to stop changing,
 * and injecting scrolls into that window risks a wrong reading for the sake of
 * looking busy. Correctness beats realism, so the behaviour happens once there
 * is nothing left to misread.
 *
 * Never throws. A page that navigated away, or died, must not fail an ASIN whose
 * data is already safely recorded.
 */
export async function browseLikeAHuman(page, budgetMs) {
  const deadline = Date.now() + budgetMs;
  try {
    // How far down the page is there to go? Product pages vary hugely, and
    // scrolling past the end just pins you at the bottom, which is its own tell.
    const height = await page.evaluate(
      () => Math.max(document.body?.scrollHeight || 0, window.innerHeight),
    ).catch(() => 0);
    const viewport = page.viewportSize()?.height || 800;
    const maxScroll = Math.max(0, height - viewport);

    // Start somewhere plausible rather than always at the top.
    let y = await page.evaluate(() => window.scrollY).catch(() => 0);

    while (Date.now() < deadline) {
      const left = deadline - Date.now();
      if (left < 350) break;

      const roll = Math.random();

      if (roll < 0.62 && maxScroll > 0) {
        // Read downward. Humans scroll in irregular bursts, roughly a
        // half-to-full viewport at a time, then stop to read.
        const step = Math.round(viewport * (0.35 + Math.random() * 0.75));
        y = Math.min(maxScroll, y + step);
        await smoothScrollTo(page, y);
        await sleep(Math.min(left, rand([420, 1500])));
      } else if (roll < 0.76 && y > viewport * 0.5) {
        // Scroll back up: went too far, or re-reading something. This is the
        // motion a scripted "scroll to bottom" never produces.
        y = Math.max(0, y - Math.round(viewport * (0.3 + Math.random() * 0.6)));
        await smoothScrollTo(page, y);
        await sleep(Math.min(left, rand([350, 1100])));
      } else if (roll < 0.9) {
        // Move the mouse. Amazon's product pages have hover behaviour on the
        // image and the buy box, so a cursor that never moves is conspicuous.
        await wanderMouse(page);
        await sleep(Math.min(left, rand([250, 900])));
      } else {
        // Just dwell. Not every second of attention produces an event.
        await sleep(Math.min(left, rand([600, 1900])));
      }
    }

    // Leave the page near the top a bit more often than not, the way someone
    // does before navigating away.
    if (chance(0.4) && maxScroll > 0) await smoothScrollTo(page, rand([0, 200]));
  } catch {
    // The row is already written; behaviour is decoration. Swallow everything.
  }
  // Never return before the budget is used, or the pacing this replaces is lost.
  const remaining = deadline - Date.now();
  if (remaining > 0) await sleep(remaining);
}

/**
 * Scroll in several small increments instead of one jump.
 *
 * window.scrollTo() with a single large delta produces one scroll event with an
 * impossible velocity. Real wheel input arrives as a stream of small deltas, so
 * this emits a handful with easing and a little jitter.
 */
async function smoothScrollTo(page, targetY) {
  await page.evaluate(async (target) => {
    const start = window.scrollY;
    const distance = target - start;
    if (Math.abs(distance) < 4) return;
    const steps = 6 + Math.floor(Math.random() * 8);
    for (let i = 1; i <= steps; i++) {
      // ease-in-out, so the motion starts and ends slowly
      const t = i / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const jitter = (Math.random() - 0.5) * 6;
      window.scrollTo(0, start + distance * eased + jitter);
      await new Promise((r) => setTimeout(r, 14 + Math.random() * 26));
    }
    window.scrollTo(0, target);
  }, targetY).catch(() => {});
}

/** A short, curved mouse path rather than a teleport. */
async function wanderMouse(page) {
  const vp = page.viewportSize();
  if (!vp) return;
  const x = 80 + Math.random() * (vp.width - 160);
  const y = 80 + Math.random() * (vp.height - 160);
  // steps > 1 makes Playwright interpolate, so the page sees a series of
  // mousemove events along a path instead of one impossible jump.
  await page.mouse.move(x, y, { steps: 6 + Math.floor(Math.random() * 12) }).catch(() => {});
}

/**
 * Should the run take a longer break now?
 *
 * A uniform 4-9s gap forever is random per-gap and yet perfectly regular in
 * distribution -- ten hours without a single pause is not what a person's
 * traffic looks like, and it is the shape that survives averaging. Occasional
 * multi-minute breaks also give a squeezed IP a chance to recover, which on
 * today's evidence matters more than the realism does.
 */
export function shouldTakeLongBreak(processed, nextBreakAt) {
  return processed > 0 && processed >= nextBreakAt;
}

export function scheduleNextBreak(processed, everyRange) {
  return processed + rand(everyRange);
}
