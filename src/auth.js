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
