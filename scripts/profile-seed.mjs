// Move a signed-in Helium 10 session between machines.
//
//   npm run profile:save            -> writes profile-seed.tar.gz
//   npm run profile:load            -> restores it into profile/
//   npm run profile:load -- --force   overwrite a profile that already exists
//
// Why this exists: signing in cannot be automated. Helium 10 serves a
// reCAPTCHA, and solving it is deliberately out of scope. That is a one-off
// annoyance on a laptop, but it is a wall on a headless GCE box -- there is no
// screen to click on. And the whole blocked-IP strategy is "redeploy on another
// server", which would otherwise mean a fresh CAPTCHA every hop.
//
// So the sign-in happens once, by hand, anywhere with a display; the session
// travels as a file. Sign-in becomes once-per-account instead of
// once-per-server, and the deploy path has no manual step left in it.
//
// THE TARBALL IS A CREDENTIAL. It contains live session cookies -- anyone
// holding it is signed in as the shared Diamond/Elite account, no password
// needed. It is gitignored and written 0600. Move it with scp, never through a
// chat message, an email or a bucket that outlives the transfer.
//
// Why an allowlist and not "tar the profile": the profile is 780 MB, of which
// 759 MB is Cache and Code Cache. The session itself is under 1 MB. A denylist
// would also risk carrying Chromium's host-specific singleton files to a machine
// where they are lies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { config } from '../src/config.js';

const ARCHIVE = path.join(config.root, 'profile-seed.tar.gz');
const PROFILE = config.profileDir;

// Everything needed to be signed in, and nothing else. Paths are relative to
// the profile directory. Missing entries are skipped, not fatal -- Chromium
// creates some of these lazily.
const KEEP = [
  // Profile-wide state. Carries the encryption key material that Cookies and
  // Login Data are sealed with, so it MUST travel with them.
  'Local State',

  // The session proper.
  'Default/Cookies',
  'Default/Login Data',

  // Preferences, including the "signed in" flags some sites re-read on load.
  'Default/Preferences',
  'Default/Secure Preferences',

  // Web storage. The Helium 10 panel keeps auth state here as well as in
  // cookies, so a cookies-only seed logs in but renders an empty panel.
  'Default/Local Storage',
  'Default/Session Storage',
  'Default/IndexedDB',

  // The extension's own chrome.storage.local -- this is where the H10 extension
  // holds its token. Without it the panel asks you to log in again despite a
  // perfectly valid cookie jar.
  'Default/Local Extension Settings',
  'Default/Extension State',
  'Default/Extension Rules',
  'Default/Extension Scripts',

  'Default/Web Data',
];

// Chromium writes these on launch and they name the host and pid that created
// them. Carried to another machine they are actively harmful: a stale
// SingletonLock is exactly what makes a launch abort with "profile already in
// use". Never saved, and deleted on load if a tarball somehow carries one.
const HOST_SPECIFIC = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

const cmd = process.argv[2];
const force = process.argv.includes('--force');

// Is SingletonLock a *live* lock, or a leftover?
//
// Presence alone proves nothing. Chromium writes the lock as a symlink whose
// target is `hostname-pid`, and it is routinely orphaned -- any script that
// calls process.exit() without closing the browser leaves one behind, and
// Chromium itself cleans up a dead one on next launch. Treating presence as
// "in use" therefore blocks on a lock nothing holds, which is exactly what
// happened the first time this ran.
//
// So parse it the way Chromium does: different host means the profile was
// copied from another machine and the pid is meaningless; same host means the
// pid is worth checking.
function liveLockHolder() {
  const lock = path.join(PROFILE, 'SingletonLock');
  let target;
  try {
    target = fs.readlinkSync(lock);
  } catch {
    return null; // absent, or not a symlink
  }
  const m = /^(.*)-(\d+)$/.exec(target);
  if (!m) return null;
  const [, host, pid] = m;
  if (host !== os.hostname()) return null; // another machine's lock: stale here
  try {
    process.kill(Number(pid), 0); // existence probe, sends nothing
    return `pid ${pid}`;
  } catch {
    return null; // no such process
  }
}

// One Chromium per profile. Reading it mid-write gives a torn SQLite file, and
// writing it under a running browser corrupts the profile outright.
function assertProfileIdle(action) {
  const holder = liveLockHolder();
  const running = spawnSync('pgrep', ['-f', 'Chrome for Testing']).status === 0;
  if (holder || running) {
    console.error(
      `Refusing to ${action}: a Chromium is using this profile ` +
      `(${holder || 'process running'}).\n` +
      `Close it first -- \`npm run login\` and \`npm run serve\` both hold the profile.`,
    );
    process.exit(1);
  }
  // A dead lock left by an earlier run. Chromium would clear it itself on the
  // next launch; clearing it here keeps it out of the tarball.
  for (const f of HOST_SPECIFIC) {
    const p = path.join(PROFILE, f);
    try {
      if (fs.lstatSync(p)) { fs.rmSync(p, { force: true }); console.log(`  cleared stale ${f}`); }
    } catch { /* not there */ }
  }
}

function du(p) {
  const r = spawnSync('du', ['-sh', p], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\t')[0].trim() : '?';
}

if (cmd === 'save') {
  if (!fs.existsSync(path.join(PROFILE, 'Default'))) {
    console.error(`No profile at ${PROFILE}. Sign in first: npm run login`);
    process.exit(1);
  }
  assertProfileIdle('save');

  const present = KEEP.filter((rel) => fs.existsSync(path.join(PROFILE, rel)));
  const missing = KEEP.filter((rel) => !fs.existsSync(path.join(PROFILE, rel)));

  if (!present.includes('Default/Cookies')) {
    console.error('Default/Cookies is missing — this profile has never signed in. Nothing to save.');
    process.exit(1);
  }

  // Paths are passed as argv entries, not through a shell, so the spaces in
  // "Local State" and "Login Data" need no quoting.
  const r = spawnSync('tar', ['-czf', ARCHIVE, '-C', PROFILE, ...present], {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) {
    console.error('tar failed');
    process.exit(1);
  }
  fs.chmodSync(ARCHIVE, 0o600);

  console.log(`\nSaved ${present.length} item(s) from the profile.`);
  if (missing.length) console.log(`  (absent, skipped: ${missing.join(', ')})`);
  console.log(`\n  ${ARCHIVE}`);
  console.log(`  ${du(ARCHIVE)}  (profile on disk: ${du(PROFILE)} — the rest is cache)`);
  console.log(`  mode 0600, gitignored`);
  console.log(`\nThis file signs you in as the shared H10 account. Move it with scp:`);
  console.log(`  scp profile-seed.tar.gz <host>:/opt/helium10-panel-scraper/`);
  console.log(`Then on that box:  npm run profile:load && npm run auth`);
  process.exit(0);
}

if (cmd === 'load') {
  if (!fs.existsSync(ARCHIVE)) {
    console.error(`No ${path.basename(ARCHIVE)} here. Copy it over from a machine that has signed in.`);
    process.exit(1);
  }
  assertProfileIdle('load');

  // Refuse to silently discard a working session. The profile that is already
  // here might be the only signed-in one anybody has.
  const existing = fs.existsSync(PROFILE) ? fs.readdirSync(PROFILE) : [];
  if (existing.length && !force) {
    console.error(
      `${PROFILE} already exists and is not empty (${existing.length} entries).\n` +
      `Re-run with --force to overwrite it. If the session there still works, ` +
      `you probably want \`npm run profile:save\` instead.`,
    );
    process.exit(1);
  }

  fs.mkdirSync(PROFILE, { recursive: true });
  const r = spawnSync('tar', ['-xzf', ARCHIVE, '-C', PROFILE], {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) {
    console.error('tar extraction failed');
    process.exit(1);
  }

  // Belt and braces: a tarball made by hand rather than by `save` could carry
  // the singleton files, and a stale one aborts every future launch.
  for (const f of HOST_SPECIFIC) {
    const p = path.join(PROFILE, f);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      console.log(`  removed host-specific ${f}`);
    }
  }

  // The archive preserves modes, but a profile copied through an intermediate
  // step may not. Session files should not be world-readable.
  for (const rel of ['Default/Cookies', 'Default/Login Data', 'Local State']) {
    const p = path.join(PROFILE, rel);
    if (fs.existsSync(p)) fs.chmodSync(p, 0o600);
  }

  console.log(`\nRestored into ${PROFILE} (${du(PROFILE)}).`);
  console.log(`\nVerify before scraping — this is the step that catches a stale session:`);
  console.log(`  npm run auth        # should say "Already signed in"`);
  console.log(`  npm run probe B0BCJFJV4W   # should read the panel`);
  console.log(`\nIf auth reports a CAPTCHA, the seed has expired: sign in again on a`);
  console.log(`machine with a display, re-save, and re-copy.`);
  process.exit(0);
}

console.error('Usage: node scripts/profile-seed.mjs save|load [--force]');
process.exit(1);
