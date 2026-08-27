// Downloads the Helium 10 extension as a CRX from Google's update service and
// unpacks it to vendor/h10-<version>/, so a server can provision the extension
// with no Chrome Web Store click, no enterprise policy and no root.
//
// Pinning matters here beyond convenience: the panel markup moved 8.42.1 ->
// 8.42.2 in nine days, and a self-updating extension can change the DOM the
// extractor depends on with no warning. A vendored copy only moves when someone
// re-runs this script.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const EXT_ID = 'njmehopjdpcckochcggncklnlmikcbnb';
const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(ROOT, 'vendor', '_tmp');

const url =
  'https://clients2.google.com/service/update2/crx' +
  '?response=redirect&acceptformat=crx2,crx3' +
  '&prodversion=151.0.0.0&x=id%3D' + EXT_ID + '%26uc';

fs.mkdirSync(TMP, { recursive: true });
const crxPath = path.join(TMP, 'h10.crx');

console.log('downloading CRX...');
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) throw new Error(`CRX download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(crxPath, buf);
console.log(`got ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

// CRX3 layout: "Cr24" magic, uint32 version, uint32 header length, protobuf
// header, then a plain zip archive. Strip everything before the zip.
if (buf.subarray(0, 4).toString() !== 'Cr24') {
  throw new Error('not a CRX file (missing Cr24 magic)');
}
const version = buf.readUInt32LE(4);
let zipStart;
if (version === 3) {
  zipStart = 12 + buf.readUInt32LE(8);
} else if (version === 2) {
  zipStart = 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
} else {
  throw new Error(`unsupported CRX version ${version}`);
}
const zipPath = path.join(TMP, 'h10.zip');
fs.writeFileSync(zipPath, buf.subarray(zipStart));

const stage = path.join(TMP, 'unpacked');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
execFileSync('unzip', ['-q', '-o', zipPath, '-d', stage]);

const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
const dest = path.join(ROOT, 'vendor', `h10-${manifest.version}`);
fs.rmSync(dest, { recursive: true, force: true });
fs.renameSync(stage, dest);
fs.rmSync(TMP, { recursive: true, force: true });

// Record the pinned version where config.js can read it.
fs.writeFileSync(
  path.join(ROOT, 'vendor', 'PINNED.json'),
  JSON.stringify({ version: manifest.version, dir: path.relative(ROOT, dest) }, null, 2) + '\n',
);

console.log(`unpacked v${manifest.version} -> ${path.relative(ROOT, dest)}`);
console.log(`manifest_version=${manifest.manifest_version}`);
