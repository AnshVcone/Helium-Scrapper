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
import { getCreds, isLoggedIn, login, explain, Auth } from '../src/auth.js';
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
// Try the automated sign-in FIRST, headless and with no window.
//
// This script used to go straight to "open a window and wait", which was right
// when Helium 10 was serving a reCAPTCHA on every attempt. It is not always
// serving one: on 2026-09-07 the form submitted cleanly with no challenge, and
// the script still sat waiting for a human who had nothing to do.
//
// So: attempt it, and fall back to the headed wait only when the response is
// actually a challenge. The risk that makes this safe to try is already handled
// -- a submission meeting a CAPTCHA revokes the *existing* session, and there is
// no session to lose here, because isLoggedIn() said so before we got this far.
async function tryAutomated() {
  const { ctx } = await openBrowser({ headless: true });
  const page = await getPage(ctx);
  try {
    if (await isLoggedIn(page)) return { ctx, page, status: Auth.ALREADY };
    const r = await login(page);
    return { ctx, page, status: r.status, detail: r.detail };
  } catch (e) {
    return { ctx, page, status: Auth.UNKNOWN, detail: String(e.message || e).slice(0, 120) };
  }
}

console.log('Trying the automated sign-in (no window needed if it works)...');
const attempt = await tryAutomated();
console.log(`  result: ${attempt.status}`);

let ctx;
let page;

let headless = true;

if (attempt.status === Auth.OK || attempt.status === Auth.ALREADY) {
  // Signed in with no human involvement.
  ctx = attempt.ctx;
  page = attempt.page;
} else {
  // A real challenge. Close the headless attempt -- one Chromium per profile --
  // and hand over to a window a person can use.
  console.log(`  ${explain(attempt.status)}`);
  if (attempt.detail) console.log(`  page said: ${attempt.detail}`);
  console.log('  Falling back to a window you can interact with.');
  await attempt.ctx.close().catch(() => {});

  const headed = await openBrowser({ headless: false });
  ctx = headed.ctx;
  page = await getPage(ctx);
  headless = false;
}

// Swap a headless context for a window. Needed when the automated sign-in
// succeeded but the panel turned out dead: the fix is a fresh human sign-in, and
// there is no window to do it in yet.
async function switchToHeaded() {
  await ctx.close().catch(() => {});
  const headed = await openBrowser({ headless: false });
  ctx = headed.ctx;
  page = await getPage(ctx);
  headless = false;
  await page.goto('https://members.helium10.com/user/signin?type=chrome-extension', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(() => {});
}

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

const signedInAlready = attempt.status === Auth.OK || attempt.status === Auth.ALREADY;

if (signedInAlready || (await isLoggedIn(page))) {
  console.log('Website session is live. Checking the panel before trusting it...');
  if (await panelWorks()) {
    await captureCookies();
    await ctx.close().catch(() => {});
    console.log(
      signedInAlready && attempt.status === Auth.OK
        ? 'Signed in automatically — no CAPTCHA was served. Session and panel both good.'
        : 'Already signed in and the panel works. Nothing to do.',
    );
    process.exit(0);
  }
  // Site session alive, panel dead: the dud. Clear the H10 cookies so the sign-in
  // form appears and a fresh session can be established by hand -- otherwise
  // isLoggedIn() keeps saying yes and this script keeps exiting on a broken
  // session.
  console.log('  Website is signed in but the panel is NOT. Clearing the session so');
  console.log('  a fresh one can be established.');
  await ctx.clearCookies({ domain: 'members.helium10.com' }).catch(() => {});
  await ctx.clearCookies({ domain: '.helium10.com' }).catch(() => {});
  if (headless) {
    // No window yet -- the automated attempt ran headless. Open one.
    await switchToHeaded();
  } else {
    await page.goto('https://members.helium10.com/user/signin?type=chrome-extension', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(() => {});
  }
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
await captureCookies();

// Capture the cookies while we hold them. Called from EVERY success path --
// the automated sign-in used to exit before reaching this, so a session created
// without a human left cookies.json stale, which is exactly the file a VM
// deploy copies.
async function captureCookies() {
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
  } catch (e) {
    // Never let this cost a sign-in that has already succeeded.
    console.error(`Could not capture cookies (the profile session is still fine): ${e.message}`);
  }
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
