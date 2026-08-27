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
};

export const rand = ([lo, hi]) => lo + Math.floor(Math.random() * (hi - lo));
