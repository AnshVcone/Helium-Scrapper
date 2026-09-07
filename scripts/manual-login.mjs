// Sign in to Helium 10 by hand, once, and leave the session in `profile/`.
//
// Automated login works until Helium 10 escalates to a visible reCAPTCHA, and
// then it cannot: solving it is deliberately out of scope. `npm run auth` is no
// help here because it reports CAPTCHA and immediately exits, closing the window
// before anyone can touch it.
//
// This opens a real window, fills the credentials from .env so only the
// challenge is left to do, and then *waits* -- polling until the session is
// live. The persistent profile keeps the cookies, so every later headless run
// rides on this one sign-in.
//
//   npm run login
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, getPage } from '../src/chrome.js';
import { config } from '../src/config.js';
import { getCreds, isLoggedIn, explain, Auth } from '../src/auth.js';
import { extractPanel, Status } from '../src/extract.js';

try {
  process.loadEnvFile(path.join(config.root, '.env'));
} catch { /* env may come from the process instead */ }

const creds = getCreds();
if (!creds) {
  console.error(explain(Auth.NO_CREDS));
  process.exit(1);
}

const WAIT_MINUTES = Number(process.env.LOGIN_WAIT_MINUTES || 10);
const deadline = Date.now() + WAIT_MINUTES * 60_000;

// Headed, always. A headless window cannot be clicked, which is the entire
// point of this script.
const { ctx } = await openBrowser({ headless: false });
const page = await getPage(ctx);

// Verify the PANEL, not just the website.
//
// These are two separate sessions. The site can be authenticated while the
// extension never receives its token, and the panel then renders but never
// populates -- every ASIN comes back TIMEOUT. It happened twice, costing a whole
// sign-in each time (3 and 5 ASINs before the run was abandoned).
//
// So a live website session is NOT sufficient evidence, which is why this runs
// on the already-signed-in path too. Checking only isLoggedIn() there is what
// let a dud session be reported as "nothing to do".
const CANARY = 'B0BCJFJV4W';
async function panelWorks() {
  try {
    console.log(`Verifying the extension panel on ${CANARY}...`);
    await page.goto(`https://www.amazon.com/dp/${CANARY}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    const r = await extractPanel(page, CANARY, 90000);
    const ok = r.status === Status.OK || r.status === Status.NO_DATA;
    console.log(`  panel status: ${r.status}${ok ? ' — the extension is authenticated' : ''}`);
    return ok;
  } catch (e) {
    console.log(`  panel check failed: ${String(e.message || e).slice(0, 90)}`);
    return false;
  }
}

if (await isLoggedIn(page)) {
  console.log('Website session is live. Checking the panel before trusting it...');
  if (await panelWorks()) {
    await ctx.close().catch(() => {});
    console.log('Already signed in and the panel works. Nothing to do.');
    process.exit(0);
  }
  // Site session alive, panel dead: the dud. Clear the H10 cookies so the sign-in
  // form appears and a fresh session can be established by hand -- otherwise
  // isLoggedIn() keeps saying yes and this script keeps exiting on a broken
  // session.
  console.log('  Website is signed in but the panel is NOT. Clearing the session so');
  console.log('  you can sign in again and get a working one.');
  await ctx.clearCookies({ domain: 'members.helium10.com' }).catch(() => {});
  await ctx.clearCookies({ domain: '.helium10.com' }).catch(() => {});
  await page.goto('https://members.helium10.com/user/signin?type=chrome-extension', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(() => {});
}

// isLoggedIn left us on the signin page. Fill it so the only thing standing
// between here and a session is the challenge itself.
await page.fill('#loginform-email', creds.email).catch(() => {});
await page.fill('#loginform-password', creds.password).catch(() => {});
const remember = page.locator('#loginform-rememberme');
if (await remember.count()) await remember.check().catch(() => {});

console.log('');
console.log('  A Chromium window is open on the Helium 10 sign-in page.');
console.log('  Email and password are already filled in.');
console.log('');
console.log('  ->  Solve the "I am not a robot" challenge and click Sign In.');
console.log('');
console.log(`  Waiting up to ${WAIT_MINUTES} minutes. Leave the window alone once you are in;`);
console.log('  this closes it as soon as the session is live.');
console.log('');

let live = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(3000);
  // Read the URL rather than re-navigating: isLoggedIn() calls goto(), which
  // would wipe a half-completed challenge out from under them.
  const url = page.url();
  if (url && !/\/user\/signin/.test(url)) {
    // Give the post-login redirect a moment to settle before trusting it.
    await page.waitForTimeout(2500);
    if (!/\/user\/signin/.test(page.url())) { live = true; break; }
  }
  const left = Math.ceil((deadline - Date.now()) / 60000);
  if (left % 2 === 0 && Date.now() % 60000 < 3100) {
    console.log(`  ...still waiting (${left} min left)`);
  }
}

if (!live) {
  console.error(`\nNo session after ${WAIT_MINUTES} minutes. Nothing was saved. Re-run when ready.`);
  await ctx.close().catch(() => {});
  process.exit(1);
}

console.log(`\nSigned in. Landed on: ${page.url()}`);
const panelOk = await panelWorks();

// Capture the cookies while we hold them.
//
// This is the honest version of "grab it from DevTools -> Application ->
// Cookies": the session was just created in *this* browser context, so reading
// it back needs no keychain, no access to anyone's personal Chrome profile, and
// no decryption -- ctx.cookies() hands over the plaintext values directly.
//
// Worth having even though profile/ already holds the session: this file is a
// few KB of inspectable JSON rather than a 220 KB profile tarball, it can be
// injected into a context that has no profile at all, and when a run dies
// mid-sweep it is the quickest way to see whether the session or something else
// was at fault.
try {
  const cookies = (await ctx.cookies()).filter((c) =>
    /helium10\.com$/i.test(String(c.domain || '').replace(/^\./, '')),
  );
  const out = path.join(config.root, 'cookies.json');
  fs.writeFileSync(out, JSON.stringify(cookies, null, 2));
  fs.chmodSync(out, 0o600);
  const hasIdentity = cookies.some((c) => c.name === '_identity');
  console.log(
    `Captured ${cookies.length} helium10 cookie(s) -> cookies.json (0600, gitignored)` +
    `${hasIdentity ? ', including _identity' : ' — WARNING: no _identity, the session may not be usable'}`,
  );
  console.log('  Set H10_COOKIES_FILE=cookies.json in .env to have runs fall back to it.');
} catch (e) {
  // Never let this cost the sign-in that was just earned by hand.
  console.error(`Could not capture cookies (the profile session is still fine): ${e.message}`);
}

// Closing the context is what flushes the profile to disk.
await ctx.close().catch(() => {});
console.log('Session saved to profile/ — headless runs will use it from now on.');

if (!panelOk) {
  console.error('');
  console.error('WARNING: the website session is live but the PANEL did not authenticate.');
  console.error('A run started now would return TIMEOUT for every ASIN and waste the');
  console.error('whole session. Re-run `npm run login` and sign in again.');
  process.exit(2);
}

console.log('Done. Website and panel both authenticated — safe to scrape.');
process.exit(0);
