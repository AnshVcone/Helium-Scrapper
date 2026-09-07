// Is the Helium 10 session live? Read-only. Submits nothing.
//
// This exists because `npm run auth` is NOT safe to use as a check. When it
// finds no session it calls login(), and a login submission that runs into a
// reCAPTCHA *destroys the existing `_identity` cookie*. Using it to "just check"
// cost a valid month-long session twice in one afternoon -- once inside a run,
// once as a diagnostic.
//
// So: navigate to the sign-in page and see whether it bounces us to the
// dashboard. That is the whole test. No form is filled, no button is clicked,
// and a live session cannot be harmed by asking.
//
// Use this before every scrape, and after `npm run profile:load`.
//
//   npm run session
import path from 'node:path';
import { openBrowser, getPage } from './chrome.js';
import { config } from './config.js';
import { ensureSession, Session } from './auth.js';

try {
  process.loadEnvFile(path.join(config.root, '.env'));
} catch { /* env may come from the process instead */ }

const { ctx } = await openBrowser({ headless: true });
const page = await getPage(ctx);

let live = false;
let how = null;
try {
  const r = await ensureSession(ctx, page);
  live = r.status === Session.LIVE || r.status === Session.LIVE_VIA_COOKIE;
  how = r;
} finally {
  // Always close: exiting with the browser up orphans profile/SingletonLock,
  // which makes every profile tool think the profile is in use.
  const cookies = await ctx.cookies().catch(() => []);
  const id = cookies.find((c) => c.name === '_identity' && /helium10/i.test(c.domain));
  await ctx.close().catch(() => {});

  console.log(`session: ${live ? how.status : 'NOT SIGNED IN'}`);
  if (how && how.injected) console.log(`injected ${how.injected} cookie(s) from the export`);
  if (how && how.reason) console.log(`reason: ${how.reason}`);
  console.log(
    `_identity cookie: ${
      id
        ? `present, expires ${new Date(id.expires * 1000).toISOString().slice(0, 10)}`
        : 'absent'
    }`,
  );
  if (!live) {
    console.log('');
    console.log('  Nothing was submitted, so nothing was made worse.');
    console.log('  To fix:  npm run login          (solve the CAPTCHA in the window)');
    console.log('     then:  npm run profile:save   (so the next box needs no CAPTCHA)');
  }
}

process.exit(live ? 0 : 1);
