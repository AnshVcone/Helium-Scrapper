import path from 'node:path';
import { openBrowser, getPage } from './chrome.js';
import { config } from './config.js';
import { login, isLoggedIn, getCreds, explain, Auth } from './auth.js';

try {
  process.loadEnvFile(path.join(config.root, '.env'));
} catch { /* optional */ }

const { ctx } = await openBrowser();
const page = await getPage(ctx);

if (!getCreds()) {
  console.error(explain(Auth.NO_CREDS));
  await ctx.close().catch(() => {});
  process.exit(1);
}

console.log(`H10_EMAIL is set (${process.env.H10_EMAIL.replace(/(.{2}).*(@.*)/, '$1***$2')})`);
console.log('H10_PASSWORD is set (value not shown)');

// Close the context on every exit path. Without this the process is killed with
// the browser still up, orphaning profile/SingletonLock -- harmless to Chromium,
// which clears a dead lock on next launch, but it makes every profile tool look
// like the profile is in use.
async function done(code) {
  await ctx.close().catch(() => {});
  process.exit(code);
}

if (await isLoggedIn(page)) {
  console.log('Already signed in -- the profile session is live.');
  await done(0);
}

// Submitting the sign-in form is a DESTRUCTIVE act. If it runs into a
// reCAPTCHA, Helium 10 invalidates whatever session the profile already had --
// proven the hard way: a valid month-long `_identity` was revoked server-side by
// exactly this call, twice in one afternoon. So this script no longer submits
// anything unless explicitly told to. Use `npm run session` to *check*.
if (!process.argv.includes('--submit')) {
  console.log('');
  console.log('Not signed in — and this command stops here by design.');
  console.log('');
  console.log('  Submitting the login form can make things WORSE: if Helium 10 answers');
  console.log('  with a CAPTCHA it revokes the profile\'s existing session server-side.');
  console.log('');
  console.log('  To check a session safely:  npm run session   (read-only)');
  console.log('  To sign in for real:        npm run login     (headed, you solve it)');
  console.log('  To force a form submit:     npm run auth -- --submit');
  await done(1);
}

const res = await login(page);
console.log(`login status: ${res.status}`);
if (res.status !== Auth.OK) {
  console.error(explain(res.status));
  if (res.detail) console.error(`page said: ${res.detail}`);
  await done(1);
}
console.log('Signed in successfully. Now run: npm run probe');
await done(0);
