// Fold the retired scraper reasons into the two-reason vocabulary.
//
//   panel_redirected  -> panel_no_data  + error_code 'served_other_asin'
//   panel_asin_dead   -> panel_no_data  + error_code 'asin_dead'
//   panel_no_data     -> error_code 'no_estimate' where it is null
//   panel_error       -> panel_unresolved + error_code 'timeout'
//
// Why this is needed and not merely tidy: `panel_redirected` and
// `panel_asin_dead` are no longer in SETTLED_MISSING_REASONS, so any row left
// carrying them would stop counting as settled. Those ASINs would be re-scraped
// forever -- the exact bug this whole change set exists to remove.
//
// DATA ONLY. No DDL: no new columns, no CHECK constraint, no enum type. The
// missing table is shared with the Go sync and its shape is not ours to change.
//
// Idempotent -- re-running it is a no-op. Touches only rows whose reason starts
// with 'panel_', so the Go sync's 145k not_returned / call_failed rows are never
// read or written.
//
//   node scripts/migrate-reasons.mjs           # report only
//   node scripts/migrate-reasons.mjs --apply   # write
import { loadEnv, getPool, tableName } from '../src/db.js';

loadEnv();

const M = tableName('helium_product_research_missing');
const apply = process.argv.includes('--apply');
const pool = getPool();

const before = await pool.query(
  `SELECT reason, error_code, COUNT(*)::int AS n
     FROM ${M} WHERE reason LIKE 'panel_%'
    GROUP BY reason, error_code ORDER BY reason, error_code`,
);
console.log(`--- ${M}: scraper rows before ---`);
console.table(before.rows);

if (!apply) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ${M}
      WHERE reason IN ('panel_redirected','panel_asin_dead','panel_error')
         OR (reason = 'panel_no_data' AND error_code IS NULL)
         OR (reason = 'panel_unresolved' AND error_code NOT IN
             ('timeout','blocked','shape_unknown','disconnected','logged_out'))`,
  );
  console.log(`\n${rows[0].n} row(s) would change. Re-run with --apply to write.`);
  await pool.end();
  process.exit(0);
}

// One transaction: a half-migrated table has rows in both vocabularies, and the
// skip check would disagree with itself about which ASINs are settled.
const client = await pool.connect();
let changed = 0;
try {
  await client.query('BEGIN');

  const steps = [
    ['panel_redirected -> panel_no_data',
     `UPDATE ${M} SET reason='panel_no_data', error_code='served_other_asin', updated_at=NOW()
       WHERE reason='panel_redirected'`],

    ['panel_asin_dead -> panel_no_data',
     `UPDATE ${M} SET reason='panel_no_data', error_code='asin_dead', updated_at=NOW()
       WHERE reason='panel_asin_dead'`],

    ['panel_error -> panel_unresolved',
     `UPDATE ${M} SET reason='panel_unresolved', error_code='timeout', updated_at=NOW()
       WHERE reason='panel_error'`],

    ['backfill no_estimate',
     `UPDATE ${M} SET error_code='no_estimate', updated_at=NOW()
       WHERE reason='panel_no_data' AND error_code IS NULL`],

    // Rows for ASINs the run never opened. These were written by the old
    // end-of-job sweep, which recorded every outstanding ASIN as a failure
    // including the ones it never reached. Folding them into 'timeout' would
    // preserve the false claim that we tried, so they are deleted outright.
    //
    // Safe to delete: panel_unresolved is retryable, so these ASINs were coming
    // back regardless, and each still has its originating not_returned row from
    // the MCP sync -- nothing disappears from the backlog view.
    ['delete NEVER_ATTEMPTED rows',
     `DELETE FROM ${M}
       WHERE reason='panel_unresolved' AND error_code='NEVER_ATTEMPTED'`],

    // Unresolved rows previously stored the raw runner Status ('TIMEOUT') as the
    // code. Lower-case it into the documented vocabulary.
    ['normalise unresolved codes',
     `UPDATE ${M} SET error_code = CASE lower(coalesce(error_code,''))
          WHEN 'timeout' THEN 'timeout'
          WHEN 'blocked' THEN 'blocked'
          WHEN 'shape_unknown' THEN 'shape_unknown'
          WHEN 'disconnected' THEN 'disconnected'
          WHEN 'logged_out' THEN 'logged_out'
          ELSE 'timeout' END,
          updated_at=NOW()
       WHERE reason='panel_unresolved'
         AND (error_code IS NULL OR error_code NOT IN
              ('timeout','blocked','shape_unknown','disconnected','logged_out'))`],
  ];

  for (const [label, sql] of steps) {
    const r = await client.query(sql);
    changed += r.rowCount;
    console.log(`  ${label}: ${r.rowCount} row(s)`);
  }

  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('\nROLLED BACK:', e.message);
  client.release();
  await pool.end();
  process.exit(1);
} finally {
  client.release();
}

const after = await pool.query(
  `SELECT reason, error_code, COUNT(*)::int AS n
     FROM ${M} WHERE reason LIKE 'panel_%'
    GROUP BY reason, error_code ORDER BY reason, error_code`,
);
console.log(`\n--- after (${changed} row(s) changed) ---`);
console.table(after.rows);

const stray = await pool.query(
  `SELECT DISTINCT reason FROM ${M}
    WHERE reason LIKE 'panel_%' AND reason NOT IN ('panel_no_data','panel_unresolved')`,
);
if (stray.rowCount) {
  console.error('\nWARNING: unexpected scraper reasons remain:',
    stray.rows.map((r) => r.reason).join(', '));
}

await pool.end();
