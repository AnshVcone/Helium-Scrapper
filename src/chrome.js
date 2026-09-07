import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from './config.js';

// Why Chromium and not Chrome:
//
// Chrome 137+ removed --load-extension from *Chrome-branded* builds. Verified
// here on Chrome 151 -- the extension list came back empty, and the
// ExtensionInstallForcelist policy route left chrome://policy blank because
// macOS only honours policy from root-owned managed preferences. The flag still
// works in Chromium and Chrome for Testing, which are not Chrome-branded, and
// Playwright ships exactly that build.
//
// This is what makes the scraper deployable: no Chrome Web Store click, no
// enterprise policy file, no root, and it works headless.
export function pinned() {
  const f = path.join(config.root, 'vendor', 'PINNED.json');
  if (!fs.existsSync(f)) {
    throw new Error('No vendored extension. Run:  node scripts/fetch-extension.mjs');
  }
  const { version, dir } = JSON.parse(fs.readFileSync(f, 'utf8'));
  const abs = path.join(config.root, dir);
  if (!fs.existsSync(path.join(abs, 'manifest.json'))) {
    throw new Error(`Vendored extension missing at ${abs}. Re-run scripts/fetch-extension.mjs`);
  }
  return { version, dir: abs };
}

export async function openBrowser({ headless = process.env.HEADLESS === '1' } = {}) {
  const ext = pinned();

  // Extensions only load in a persistent context -- there is no way to attach
  // one to an ephemeral browser.
  //
  // One profile, one Chromium: the directory carries a SingletonLock and a
  // second process aborts rather than risk corrupting it. That is the right
  // behaviour, but Playwright reports it as a wall of launch flags, so the cause
  // is translated below. It happens for real -- `npm run login` holds the
  // profile while it waits for a CAPTCHA, and a job starting in that window
  // (including one `restore()` re-queued on boot) dies on the lock.
  const ctx = await launchOrExplain({
    channel: 'chromium',
    headless,
    viewport: null,
    args: [
      `--disable-extensions-except=${ext.dir}`,
      `--load-extension=${ext.dir}`,
      // Chromium's sandbox needs privileges a container usually does not grant.
      // Without this it fails to start at all as root, so the Dockerfile sets
      // NO_SANDBOX=1. Left off locally, where the sandbox works fine.
      ...(process.env.NO_SANDBOX === '1'
        ? ['--no-sandbox', '--disable-dev-shm-usage']
        : []),
    ],
  });

  // MV3 background is a service worker; give it a moment to come up before the
  // first page asks for panel markup.
  // (see launchOrExplain below for why the launch is wrapped)
  await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => {});

  return { ctx, extensionVersion: ext.version };
}

// Translate the one launch failure that has a human cause into a message that
// names it. Everything else is re-thrown untouched.
async function launchOrExplain(opts) {
  try {
    return await chromium.launchPersistentContext(config.profileDir, opts);
  } catch (err) {
    if (/ProcessSingleton|SingletonLock|already in use/i.test(String(err.message))) {
      throw new Error(
        `The browser profile at ${config.profileDir} is already open in another ` +
        `Chromium. Is \`npm run login\` still waiting for a sign-in, or another ` +
        `scrape running? Only one may hold the profile at a time. Close the other ` +
        `one and retry -- nothing was written.`,
      );
    }
    throw err;
  }
}

export async function getPage(ctx) {
  const pages = ctx.pages().filter((p) => !p.url().startsWith('devtools://'));
  return pages[0] || (await ctx.newPage());
}
