import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Automated Helium 10 sign-in, so a deployed run does not need a human.
// Credentials come from the environment and are never logged, never written to
// disk by this module, and never echoed in an error message.
//
// Selectors below were read off the live form at members.helium10.com/user/signin,
// not guessed: #loginform-email, #loginform-password, #loginform-rememberme.

export const Auth = {
  OK: 'OK',
  ALREADY: 'ALREADY',
  NO_CREDS: 'NO_CREDS',
  BAD_CREDENTIALS: 'BAD_CREDENTIALS',
  CAPTCHA: 'CAPTCHA',
  TWO_FACTOR: 'TWO_FACTOR',
  UNKNOWN: 'UNKNOWN',
};

// The `type=chrome-extension` parameter matters: it is the flow the extension
// itself uses, and it is what hands the session to the extension rather than
// only to the website. Signing in at the plain /user/signin URL authenticates
// the site but leaves the panel showing "Please log in to launch".
const SIGNIN_URL = 'https://members.helium10.com/user/signin?type=chrome-extension';

export function getCreds() {
  const email = process.env.H10_EMAIL;
  const password = process.env.H10_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}

// A session cookie lifted from a browser where a human signed in. This is the
// way around the reCAPTCHA that does not involve defeating it: the human solves
// it once in their own Chrome, and the scraper borrows the resulting session.
//
// Copy it from DevTools -> Application -> Cookies -> members.helium10.com ->
// _identity, and put the value in .env as H10_IDENTITY_COOKIE.
export function getIdentityCookie() {
  const v = (process.env.H10_IDENTITY_COOKIE || '').trim();
  return v || null;
}

// Attributes are copied from a real _identity row rather than guessed:
//   host_key members.helium10.com | path / | secure 0 | httponly 1 | samesite Lax
// Host-only, not `.helium10.com` -- a domain cookie is a different cookie as far
// as the browser is concerned, and getting it wrong means it is simply not sent.
const IDENTITY = {
  name: '_identity',
  domain: 'members.helium10.com',
  path: '/',
  httpOnly: true,
  secure: false,
  sameSite: 'Lax',
};

/**
 * Put the configured session cookie into the context. Returns false if none is
 * configured. Does not verify anything -- callers check the result themselves.
 */
export async function injectIdentityCookie(ctx) {
  const value = getIdentityCookie();
  if (!value) return false;
  await ctx.addCookies([{ ...IDENTITY, value }]);
  return true;
}

// A whole exported cookie set, rather than one cookie.
//
// `_identity` alone was tried first and the server cleared it on sight. Yii's
// auto-login is not the only thing gating that session: there is a session id
// and a CSRF cookie alongside it, and presenting a bare auth cookie with no
// matching session looks exactly like a replayed token -- which is presumably
// why it is rejected rather than ignored.
//
// So take the lot. Export the helium10.com cookies from a browser that is signed
// in (DevTools -> Application, or any cookie-export extension), save the JSON
// array as cookies.json, and point H10_COOKIES_FILE at it.
//
// Accepts both common shapes: Playwright's own ({name, value, domain, path,
// httpOnly, secure, sameSite, expires}) and the EditThisCookie/Chrome format
// ({hostOnly, session, expirationDate, sameSite: "no_restriction"|...}).
export function getCookiesFile() {
  return (process.env.H10_COOKIES_FILE || '').trim() || null;
}

const SAMESITE = {
  no_restriction: 'None', none: 'None', unspecified: 'Lax',
  lax: 'Lax', strict: 'Strict',
};

export async function injectCookieFile(ctx) {
  const file = getCookiesFile();
  if (!file) return { injected: 0 };

  const abs = path.isAbsolute(file) ? file : path.join(config.root, file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return { injected: 0, error: `could not read ${abs}: ${e.message}` };
  }
  const list = Array.isArray(raw) ? raw : raw.cookies;
  if (!Array.isArray(list)) return { injected: 0, error: 'expected a JSON array of cookies' };

  const cookies = [];
  for (const c of list) {
    if (!c || !c.name || c.value === undefined) continue;
    // Only helium10. A dump from a live browser carries every site the person
    // has visited, and injecting unrelated sessions into a scraper is both
    // pointless and a privacy problem.
    const domain = String(c.domain || '');
    if (!/helium10\.com$/i.test(domain.replace(/^\./, ''))) continue;

    const out = {
      name: c.name,
      value: String(c.value),
      domain,
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
    };
    const ss = SAMESITE[String(c.sameSite || '').toLowerCase()];
    if (ss) out.sameSite = ss;
    // A session cookie has no expiry; anything else keeps the one it had.
    const exp = c.expires ?? c.expirationDate;
    if (exp && exp > 0 && !c.session) out.expires = Math.floor(exp);
    cookies.push(out);
  }

  if (!cookies.length) return { injected: 0, error: 'no helium10.com cookies in the file' };
  await ctx.addCookies(cookies);
  return { injected: cookies.length, names: cookies.map((c) => c.name) };
}

export const Session = {
  LIVE: 'LIVE',                     // already signed in
  LIVE_VIA_COOKIE: 'LIVE_VIA_COOKIE', // the injected cookie worked
  SITE_ONLY: 'SITE_ONLY',           // site session works, panel does not
  DEAD: 'DEAD',                     // nothing worked
};

/**
 * Get to a usable session without ever submitting the login form.
 *
 * Order matters: check first, inject only if needed. Re-injecting over a working
 * session is pointless and would overwrite a fresher cookie with a staler one.
 *
 * SITE_ONLY is a real and non-obvious outcome. Signing in at the plain website
 * authenticates the *site*; the extension gets its session through the
 * `type=chrome-extension` flow and keeps its own token in
 * Default/Local Extension Settings. So a borrowed website cookie can leave
 * isLoggedIn() true while the panel still reads "Please log in to launch" --
 * which is why the caller must judge on the panel, not on this alone.
 */
export async function ensureSession(ctx, page) {
  if (await isLoggedIn(page)) return { status: Session.LIVE };

  // Prefer the full set: a lone auth cookie was rejected outright by the server.
  const file = await injectCookieFile(ctx);
  if (file.injected) {
    if (await isLoggedIn(page)) {
      return { status: Session.LIVE_VIA_COOKIE, injected: file.injected, names: file.names };
    }
    return {
      status: Session.DEAD,
      reason: `injected ${file.injected} cookie(s) from H10_COOKIES_FILE but the server did not accept them`,
    };
  }

  if (await injectIdentityCookie(ctx)) {
    if (await isLoggedIn(page)) return { status: Session.LIVE_VIA_COOKIE, injected: 1 };
    return { status: Session.DEAD, reason: 'H10_IDENTITY_COOKIE was rejected by the server' };
  }

  return {
    status: Session.DEAD,
    reason: file.error || 'no H10_COOKIES_FILE or H10_IDENTITY_COOKIE configured',
  };
}

/**
 * Touch the Helium 10 site so its session does not idle out.
 *
 * A run only ever loads amazon.com pages. helium10.com is never requested for
 * the whole run, so if the session has an *idle* timeout we are guaranteed to
 * trip it. Three runs died at 32, 6 and 29 minutes; with other logins ruled out
 * by a controlled test, a ~30 minute idle expiry is the best remaining
 * explanation -- and `_identity` claiming an expiry a month out is not evidence
 * against it, because the cookie's lifetime and the server-side session's
 * lifetime are different things.
 *
 * Done in a throwaway tab in the same context, so it shares the cookie jar (no
 * new device, no new login) and cannot disturb the Amazon page mid-extraction.
 *
 * Returns {alive} -- false means the site bounced us to signin, which is an
 * early warning worth logging before the next ASIN fails on it.
 */
export async function touchSession(ctx) {
  let tab;
  try {
    tab = await ctx.newPage();
    await tab.goto('https://members.helium10.com/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    const alive = !/\/user\/signin/.test(tab.url());
    return { alive };
  } catch (e) {
    // A keep-alive must never be able to end a run. A failure here is worth a
    // log line and nothing more.
    return { alive: null, error: String(e.message || e).slice(0, 120) };
  } finally {
    await tab?.close().catch(() => {});
  }
}

// Redact anything that looks like the secret before it can reach a log line.
export function redact(text, password) {
  if (!text) return text;
  let out = String(text);
  if (password) out = out.split(password).join('********');
  return out;
}

export async function isLoggedIn(page) {
  // The signin page bounces authenticated sessions to the dashboard, so the
  // landing URL is the cheapest reliable session probe.
  await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  return !/\/user\/signin/.test(page.url());
}

export async function login(page) {
  const creds = getCreds();
  if (!creds) return { status: Auth.NO_CREDS };

  if (await isLoggedIn(page)) return { status: Auth.ALREADY };

  await page.fill('#loginform-email', creds.email);
  await page.fill('#loginform-password', creds.password);

  // "Remember me" is what keeps a deployed run from re-authenticating on every
  // pass, which is both slower and more likely to trip bot scoring.
  const remember = page.locator('#loginform-rememberme');
  if (await remember.count()) {
    await remember.check().catch(() => {});
  }

  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    page.locator('button[type=submit]').first().click(),
  ]);
  await page.waitForTimeout(4000);

  const url = page.url();
  if (!/\/user\/signin/.test(url)) {
    // Some accounts land on an interstitial before the dashboard.
    if (/two|2fa|verify|otp|mfa/i.test(url)) return { status: Auth.TWO_FACTOR };
    return { status: Auth.OK };
  }

  // Still on the signin page: work out why, without ever surfacing the secret.
  const page_text = await page.locator('body').innerText().catch(() => '');

  // The form carries a reCAPTCHA field. If Helium 10 escalates to a visible
  // challenge, this stops. Solving it is out of scope by design -- log in by
  // hand once and the profile session carries the run.
  const captchaVisible = await page
    .locator('iframe[title*="recaptcha" i], iframe[src*="recaptcha"], .g-recaptcha')
    .first()
    .isVisible()
    .catch(() => false);
  if (captchaVisible || /verify you are human|i'?m not a robot/i.test(page_text)) {
    return { status: Auth.CAPTCHA };
  }

  if (/incorrect|invalid|does not match|wrong (email|password)/i.test(page_text)) {
    return { status: Auth.BAD_CREDENTIALS };
  }

  if (/two-factor|verification code|authenticator/i.test(page_text)) {
    return { status: Auth.TWO_FACTOR };
  }

  return {
    status: Auth.UNKNOWN,
    detail: redact(page_text.slice(0, 200), creds.password),
  };
}

export function explain(status) {
  switch (status) {
    case Auth.NO_CREDS:
      return 'H10_EMAIL / H10_PASSWORD are not set. Copy .env.example to .env and fill them in.';
    case Auth.BAD_CREDENTIALS:
      return 'Helium 10 rejected the email/password in .env.';
    case Auth.CAPTCHA:
      return 'Helium 10 served a CAPTCHA. Sign in by hand once with HEADLESS=0 and a visible window; ' +
             'the profile session will carry subsequent runs.';
    case Auth.TWO_FACTOR:
      return 'The account has 2FA enabled, which cannot be automated. Sign in by hand ' +
             'once in a visible window, or use a seat without 2FA for the scraper.';
    case Auth.UNKNOWN:
      return 'Sign-in did not complete and the reason was not recognised. Run `npm run auth` with a visible window ' +
             'and sign in by hand to see what the page is asking for.';
    default:
      return '';
  }
}
