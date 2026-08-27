// CLI wrapper around the same runner the HTTP service uses, so a local run and
// an uploaded job cannot drift apart.
//
//   node src/scrape.js                 # ASINs from input/asins.txt, no DB write
//   node src/scrape.js --db            # also upsert into the research tables
import fs from 'node:fs';
import { config } from './config.js';
import { loadEnv } from './db.js';
import { runJob, parseAsins } from './runner.js';

loadEnv();

const writeDb = process.argv.includes('--db');

const raw = fs.readFileSync(config.inputFile, 'utf8');
const { asins, rejected } = parseAsins(raw);
console.log(`${asins.length} ASINs (${rejected.length} tokens rejected)`);
if (rejected.length) console.log(`  rejected: ${rejected.slice(0, 5).join(', ')}`);
if (!asins.length) process.exit(0);
console.log(writeDb ? 'writing to Postgres' : 'DRY RUN (pass --db to write to Postgres)');

const started = Date.now();
const summary = await runJob({
  asins,
  writeDb,
  onProgress: (s) =>
    console.log(`[${s.processed}/${s.total}] ${s.current} ${s.lastStatus}`),
});

const elapsed = (Date.now() - started) / 1000;
console.log(`\n--- ${summary.processed} ASINs in ${elapsed.toFixed(0)}s ---`);
console.log(`found ${summary.found} | missing ${summary.missing} | errors ${summary.errors}`);
console.log(`${writeDb ? 'inserted' : 'would insert'}: found ${summary.insertedFound}, missing ${summary.insertedMissing}`);
console.log(`per ASIN: ~${(elapsed / Math.max(1, summary.processed)).toFixed(1)}s`);
console.log(`projection: 1,000 ASINs ~= ${((elapsed / Math.max(1, summary.processed)) * 1000 / 3600).toFixed(1)}h`);
console.log('statuses:', summary.byStatus);
if (summary.aborted) console.error(`ABORTED: ${summary.aborted}`);

process.exit(0);
