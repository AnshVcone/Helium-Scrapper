import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, getPage } from './chrome.js';
import { loadEnv } from './db.js';
import { checkPanelVersion } from './browser.js';
import { config } from './config.js';
import { extractPanel } from './extract.js';

// Run after login, and again after any extension update. Dumps what the panel
// actually renders, so the extractor is checked against real markup rather than
// assumed markup.
const asin = process.argv[2] || 'B0BCJFJV4W';

// Without this, nothing in .env is visible here -- which is how HEADLESS=1 went
// unread on the VM and the launch tried to open a window on a box with no X
// server.
loadEnv();

const { ctx } = await openBrowser();
const page = await getPage(ctx);

await page.goto(`${config.marketplace}/dp/${asin}`, { waitUntil: 'domcontentloaded' });

const result = await extractPanel(page, asin, config.panelTimeoutMs);

const dump = await page.evaluate(() => {
  const trees = [];
  let i = 0;
  const walk = (root, d) => {
    if (d > 6) return;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        trees.push({
          i: i++,
          host: el.tagName,
          cls: (el.className || '').toString().slice(0, 80),
          text: (el.shadowRoot.textContent || '').slice(0, 4000),
        });
        walk(el.shadowRoot, d + 1);
      }
    }
  };
  walk(document, 0);
  return { trees, bodyText: (document.body.innerText || '').slice(0, 2000) };
});

fs.mkdirSync(path.join(config.root, 'output'), { recursive: true });
const out = path.join(config.root, 'output', `probe-${asin}.json`);
fs.writeFileSync(out, JSON.stringify({ asin, result, dump }, null, 2));

console.log(`status=${result.status}`);
console.log(`revenueCents=${result.revenueCents ?? 'null'} unitSales=${result.unitSales ?? 'null'}`);
console.log(`raw: revenue=${JSON.stringify(result.rawRevenue)} units=${JSON.stringify(result.rawUnits)}`);
console.log(`ranks=${JSON.stringify(result.ranks ?? null)}`);
console.log(`extension v=${result.extensionVersion ?? 'unknown'}`);
const v = checkPanelVersion(result.extensionVersion);
if (!v.ok) console.warn(`WARNING: ${v.note}`);
console.log(`shadow trees: ${dump.trees.length}`);
console.log(`full dump -> ${out}`);

// A CDP-attached browser keeps the event loop alive; exit explicitly.
process.exit(0);
