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
  process.exit(1);
}

console.log(`H10_EMAIL is set (${process.env.H10_EMAIL.replace(/(.{2}).*(@.*)/, '$1***$2')})`);
console.log('H10_PASSWORD is set (value not shown)');

if (await isLoggedIn(page)) {
  console.log('Already signed in -- the profile session is live.');
  process.exit(0);
}

const res = await login(page);
console.log(`login status: ${res.status}`);
if (res.status !== Auth.OK) {
  console.error(explain(res.status));
  if (res.detail) console.error(`page said: ${res.detail}`);
  process.exit(1);
}
console.log('Signed in successfully. Now run: npm run probe');
process.exit(0);
