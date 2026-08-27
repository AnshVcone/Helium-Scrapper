import {
  parseMoneyToCents,
  parseIntOrNull,
  parseFloatOrNull,
  looksLikeMoney,
  looksLikeUnits,
} from './normalize.js';
import { config } from './config.js';

// Outcome codes. Every row lands in exactly one, and only OK rows carry
// numbers. NO_DATA and SHAPE_UNKNOWN are deliberately separate: the first is a
// fact about the product, the second is a bug in this file.
export const Status = {
  OK: 'OK',
  NO_DATA: 'NO_DATA',
  REDIRECTED: 'REDIRECTED',
  DEAD: 'DEAD',
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  BLOCKED: 'BLOCKED',
  SHAPE_UNKNOWN: 'SHAPE_UNKNOWN',
  TIMEOUT: 'TIMEOUT',
  DISCONNECTED: 'DISCONNECTED',
  EXTENSION_MISSING: 'EXTENSION_MISSING',
};

const ANCHOR = 'Product Summary for';
const LOGGED_OUT = 'Please log in to launch';

// Confirmed layout of the panel, read off a live page (v8.42.2). The panel
// renders into the Amazon document with real line breaks, so innerText -- not
// textContent -- is what carries the label/value structure:
//
//   Product Summary for "B0BCJFJV4W"
//   Track Competitor
//   Save Product Idea
//   Health & Household
//   #31,294
//   Vitamin B12 Supplements
//   #144
//   30-Day Revenue
//   $24,645
//   Unit Sales:
//   894
//   Current Rating
//   4.6
//   (813)
//   ...
//   Version 8.42.2

export async function extractPanel(page, requestedAsin, timeoutMs) {
  // 1. Redirect guard. Amazon silently serves a different product for dead or
  // merged ASINs -- measured at 1 in 10, and hit on the first test ASIN here
  // (/dp/B00TS72KBI served B07HHCY48X). Keying a row on the requested ASIN
  // would write one product's revenue onto another's row, and nothing in the
  // output would look wrong.
  // Wait for the page to actually be a product page before judging anything.
  // Without this a slow render looks identical to a dead ASIN, and every
  // downstream decision is made against a half-built DOM.
  await page
    .waitForFunction(
      () =>
        !!document.querySelector('#ASIN') ||
        /Page Not Found|couldn't find that page|Looking for something\?|dogs of amazon/i.test(
          document.body?.innerText || '',
        ),
      undefined,
      { timeout: timeoutMs },
    )
    .catch(() => {});

  const onPageAsin = await page
    .locator('#ASIN')
    .first()
    .inputValue()
    .catch(() => null);

  const bodyText = await page.locator('body').innerText().catch(() => '');

  if (!onPageAsin && /Page Not Found|we couldn't find that page/i.test(bodyText)) {
    return { status: Status.DEAD, onPageAsin: null };
  }
  if (/Enter the characters you see below|api-services-support@amazon/i.test(bodyText)) {
    return { status: Status.BLOCKED, onPageAsin };
  }
  if (onPageAsin && onPageAsin.toUpperCase() !== requestedAsin.toUpperCase()) {
    return { status: Status.REDIRECTED, onPageAsin };
  }

  // 2. Get the panel on screen. It may be collapsed, in which case a passive
  // wait just burns the timeout -- that cost 47s per ASIN before this existed.
  if (!(await panelPresent(page, 8000))) {
    if (!(await openPanel(page))) {
      if (!onPageAsin) {
        // No #ASIN field. That is either a genuine not-found page, or a page
        // that simply had not rendered yet. The two must not be conflated:
        // DEAD is a settled verdict that permanently drops the ASIN from the
        // backlog, while TIMEOUT is unwritten and simply tried again. So DEAD
        // requires positive evidence, and anything else degrades to TIMEOUT.
        const notFound =
          /Page Not Found|couldn't find that page|Looking for something\?|dogs of amazon/i
            .test(bodyText);
        return notFound
          ? { status: Status.DEAD, onPageAsin: null }
          : { status: Status.TIMEOUT, onPageAsin: null };
      }
      // A real product page with no launcher: the extension genuinely is not
      // running in this profile.
      return { status: Status.EXTENSION_MISSING, onPageAsin };
    }
    if (!(await panelPresent(page, timeoutMs))) {
      return { status: Status.TIMEOUT, onPageAsin };
    }
  }

  if (new RegExp(LOGGED_OUT, 'i').test(await panelText(page))) {
    return { status: Status.NOT_LOGGED_IN, onPageAsin };
  }

  // 3. Wait for the values to appear AND stop changing.
  //
  // Two separate hazards. The panel paints its tile labels well before the
  // figures arrive, so reading at the anchor returned a null revenue on a
  // product that actually had $24,645. And it can paint an interim figure --
  // $0 in particular -- before the real one lands, so a single successful read
  // is not proof either. A value is trusted only after N identical consecutive
  // samples spaced valueStabilityMs apart.
  const stable = await waitForStableValues(page, timeoutMs);

  // No stable reading means no reading. Recording the last thing on screen here
  // is exactly how a wrong number, or a false "no data", gets written -- so this
  // returns TIMEOUT, which is never persisted and is simply tried again.
  if (!stable.ok) {
    return {
      status: Status.TIMEOUT,
      onPageAsin,
      note: stable.reason,
      lastSeen: stable.last,
    };
  }

  const text = await panelText(page);
  const region = panelRegion(text);

  if (!region) {
    return { status: Status.SHAPE_UNKNOWN, onPageAsin, panelText: text };
  }

  // 4. Second redirect guard, on the panel itself: it prints the ASIN it is
  // reporting on, so a disagreement means the numbers belong to another product.
  const panelAsin = (region.match(/Product Summary for\s*"?([A-Z0-9]{10})"?/) || [])[1] || null;
  if (panelAsin && panelAsin.toUpperCase() !== requestedAsin.toUpperCase()) {
    return { status: Status.REDIRECTED, onPageAsin, panelAsin };
  }

  const rawRevenue = after(region, /30-Day Revenue\s*\n\s*([^\n]+)/);
  const rawUnits = after(region, /Unit Sales:\s*\n?\s*([^\n]+)/);

  // The final read happens after the stability check, against a DOM that could
  // in principle have moved again. Re-validate rather than trust it: a value
  // that is not value-shaped means we are looking at labels, not figures.
  if (rawRevenue !== null && !looksLikeMoney(rawRevenue)) {
    return {
      status: Status.TIMEOUT,
      onPageAsin,
      panelAsin,
      note: `revenue slot held non-value text ("${rawRevenue}")`,
    };
  }
  if (rawUnits !== null && !looksLikeUnits(rawUnits)) {
    return {
      status: Status.TIMEOUT,
      onPageAsin,
      panelAsin,
      note: `unit sales slot held non-value text ("${rawUnits}")`,
    };
  }

  // Both labels absent while the anchor is present means the markup moved.
  // Returning nulls here would quietly fill the column with blanks.
  if (rawRevenue === null && rawUnits === null) {
    return { status: Status.SHAPE_UNKNOWN, onPageAsin, panelAsin, panelText: text };
  }

  let revenueCents = parseMoneyToCents(rawRevenue);
  const unitSales = parseIntOrNull(rawUnits);

  // "$0 with N/A units" is the absence of an estimate, not a measured zero.
  // Verified by watching one panel for 30s: it stays at $0 / N/A rather than
  // resolving, and Helium 10's own API returns 0/null for the same ASINs. Left
  // as a real 0 it would sink every downstream AVG -- the same failure the -1
  // sentinel causes. The raw strings are kept so the call stays auditable.
  const noEstimate = revenueCents === 0 && unitSales === null;
  if (noEstimate) revenueCents = null;

  return {
    status:
      revenueCents === null && unitSales === null ? Status.NO_DATA : Status.OK,
    onPageAsin,
    panelAsin,
    revenueCents,
    unitSales,
    ranks: parseRanksFromRegion(region),
    rating: parseFloatOrNull(after(region, /Current Rating\s*\n\s*([\d.]+)/)),
    reviewCount: parseIntOrNull(after(region, /Current Rating\s*\n\s*[\d.]+\s*\n\s*\(([\d,]+)\)/)),
    listingHealthScore: parseFloatOrNull(after(region, /Listing Health Score\s*\n\s*([\d.]+)/)),
    extensionVersion: (region.match(/Version\s+([\d.]+)/) || [])[1] || null,
    valuesSettled: true,
    stableSamples: stable.samples,
    rawRevenue,
    rawUnits,
  };
}

// Samples the two target figures until they repeat unchanged. Returns ok:false
// rather than a best guess when they never settle.
async function waitForStableValues(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let identical = 0;
  let samples = 0;
  let last = null;

  while (Date.now() < deadline) {
    const sample = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const i = t.indexOf('Product Summary for');
      if (i < 0) return null;
      const region = t.slice(i, i + 3000);
      const rev = (region.match(/30-Day Revenue\s*\n\s*([^\n]+)/) || [])[1];
      const un = (region.match(/Unit Sales:\s*\n?\s*([^\n]+)/) || [])[1];
      if (rev === undefined && un === undefined) return null;
      return `${(rev || '').trim()}|${(un || '').trim()}`;
    });

    samples++;
    last = sample;

    // A sample counts only if the revenue slot holds something shaped like a
    // figure. Early on it holds the next tile's label instead, and two early
    // samples of that label are identical -- which is how a label got recorded
    // as a value.
    const populated = sample !== null && sampleIsValued(sample);

    if (populated && sample === previous) {
      identical++;
      if (identical >= config.valueStabilitySamples - 1) {
        return { ok: true, samples, value: sample };
      }
    } else {
      identical = 0;
    }
    previous = populated ? sample : null;

    await page.waitForTimeout(config.valueStabilityMs);
  }

  return {
    ok: false,
    samples,
    last,
    reason: last === null
      ? 'panel figures never appeared'
      : `figures never stopped changing (last seen "${last}")`,
  };
}

function sampleIsValued(sample) {
  const [rev, un] = String(sample).split('|');
  if (!looksLikeMoney(rev)) return false;
  // Units may legitimately be absent from the layout; if present it must parse.
  if (un && un.trim() && !looksLikeUnits(un)) return false;
  return true;
}

const after = (text, re) => {
  const m = text.match(re);
  return m ? m[1].trim() : null;
};

// Isolate the panel's own text before matching anything. Amazon's page has its
// own "Best Sellers Rank" and rating markup, and matching across the whole body
// would happily pick those up instead.
function panelRegion(text) {
  const i = text.indexOf(ANCHOR);
  if (i < 0) return null;
  const rest = text.slice(i);
  const end = rest.search(/Version\s+\d+\.\d+\.\d+/);
  return end > 0 ? rest.slice(0, end + 40) : rest.slice(0, 3000);
}

// Ranks appear as a category line followed by a "#123,456" line, before the
// revenue tile. Keeping the category names makes a wrong-category read visible.
function parseRanksFromRegion(region) {
  const head = region.split(/30-Day Revenue/)[0] || '';
  const out = [];
  const re = /([^\n]+)\n\s*#([\d,]+)/g;
  let m;
  while ((m = re.exec(head))) {
    const category = m[1].trim();
    if (/Track Competitor|Save Product Idea|Product Summary/i.test(category)) continue;
    const rank = parseIntOrNull(m[2]);
    if (rank !== null) out.push({ category, rank });
  }
  return out;
}

async function panelText(page) {
  return page.evaluate(() => {
    let s = document.body.innerText || '';
    // The logged-out prompt lives in a shadow root rather than the page body.
    if (!s.includes('Product Summary for')) {
      const walk = (root, d) => {
        if (d > 6) return;
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            s += '\n' + (el.innerText || el.shadowRoot.textContent || '');
            walk(el.shadowRoot, d + 1);
          }
        }
      };
      walk(document, 0);
    }
    return s;
  });
}

async function panelPresent(page, timeout) {
  try {
    await page.waitForFunction(
      (anchors) => {
        let s = document.body.innerText || '';
        const walk = (root, d) => {
          if (d > 6) return;
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
              s += el.shadowRoot.textContent || '';
              walk(el.shadowRoot, d + 1);
            }
          }
        };
        walk(document, 0);
        return anchors.some((a) => s.includes(a));
      },
      [ANCHOR, LOGGED_OUT],
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

// The launcher is the floating Helium 10 button. It lives in a shadow root, so
// click it by its on-screen box -- the class names are build-generated and
// change between versions.
async function openPanel(page) {
  const box = await page.evaluate(() => {
    const cands = [];
    const walk = (root, d) => {
      if (d > 6) return;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          for (const n of el.shadowRoot.querySelectorAll('div,button,img,svg')) {
            const r = n.getBoundingClientRect();
            const smallSquare = r.width > 24 && r.width < 90 && r.height > 24 && r.height < 90;
            if (smallSquare && r.right > window.innerWidth - 140 && r.top > 0) {
              cands.push({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            }
          }
          walk(el.shadowRoot, d + 1);
        }
      }
    };
    walk(document, 0);
    return cands[0] || null;
  });

  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
}
