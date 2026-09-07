import path from 'node:path';
import pg from 'pg';
import { config } from './config.js';

// Writes into the same two tables the Go sync uses:
//   <prefix>helium_product_research          - data found
//   <prefix>helium_product_research_missing   - nothing found
//
// Both are keyed (requested_asin, marketplace, fetch_date), so a re-run on the
// same day updates rather than duplicating.

let pool = null;

// Which database a run writes to. `dev` for a test sweep, `staging` for the
// real one.
//
// Default is dev, deliberately. An unconfigured box must not write to staging
// just because someone forgot to set a variable -- the safe direction for a
// missing value is the throwaway database, not the shared one.
export const MODE = (process.env.SCRAPER_MODE || 'dev').toLowerCase();

const VALID_MODES = ['dev', 'staging'];
if (!VALID_MODES.includes(MODE)) {
  throw new Error(
    `SCRAPER_MODE is "${MODE}"; expected one of ${VALID_MODES.join(', ')}`,
  );
}

/**
 * Read a DB setting for the active mode.
 *
 * DEV_DB_HOST / STAGING_DB_HOST take precedence; the unprefixed DB_HOST is a
 * fallback so an existing .env keeps working.
 *
 * The fallback is allowed in staging mode ONLY. This asymmetry is the whole
 * point: the legacy unprefixed variables point at staging, so letting dev mode
 * fall back to them would silently write a "dev test run" into the shared
 * staging tables -- the exact accident this switch exists to prevent. In dev
 * mode a missing DEV_DB_* is an error, not a default.
 */
function dbSetting(key, { required = false } = {}) {
  const scoped = process.env[`${MODE.toUpperCase()}_DB_${key}`];
  if (scoped !== undefined && scoped !== '') return scoped;

  if (MODE === 'staging') {
    const legacy = process.env[`DB_${key}`];
    if (legacy !== undefined && legacy !== '') return legacy;
  }

  if (required) {
    throw new Error(
      `${MODE.toUpperCase()}_DB_${key} is not set, and SCRAPER_MODE=${MODE}` +
      (MODE === 'dev'
        ? '. Dev mode will not fall back to the unprefixed DB_* variables: ' +
          'those point at staging, and falling back would write test data into ' +
          'the shared tables. Set DEV_DB_HOST / DEV_DB_NAME / DEV_DB_USER / ' +
          'DEV_DB_PASS in .env.'
        : '.'),
    );
  }
  return undefined;
}

/** Host/db/user for the active mode, safe to log. Never includes the password. */
export function dbTarget() {
  return {
    mode: MODE,
    host: dbSetting('HOST', { required: true }),
    port: Number(dbSetting('PORT') || 5432),
    database: dbSetting('NAME', { required: true }),
    user: dbSetting('USER', { required: true }),
    tablePrefix: dbSetting('TABLE_PREFIX') || '',
  };
}

export function getPool() {
  if (pool) return pool;

  const t = dbTarget();
  pool = new pg.Pool({
    host: t.host,
    port: t.port,
    database: t.database,
    user: t.user,
    password: dbSetting('PASS'),
    max: Number(dbSetting('POOL_MAX') || 5),
    idleTimeoutMillis: 30000,
    // Both hosts are reached over the public internet, so getting a connection
    // is the flaky part rather than running the query. 15s was not enough: a
    // blip aborted the ledger lookup mid-run.
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 30000),
  });

  console.log(
    `[db] SCRAPER_MODE=${t.mode} -> ${t.user}@${t.host}:${t.port}/${t.database} ` +
    `prefix "${t.tablePrefix}"`,
  );

  // A pool error with no listener takes the process down.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  return pool;
}

export function tableName(base) {
  const prefix = dbSetting('TABLE_PREFIX') || '';
  return `${prefix}${base}`;
}

export async function ping() {
  const { rows } = await getPool().query(
    'SELECT current_database() AS db, current_user AS usr, now() AS ts',
  );
  return rows[0];
}

// Only the columns the panel actually produces are listed. That is deliberate:
// the upsert sets EXCLUDED only for listed columns, so a scraper row cannot
// blank out the ~60 columns an MCP row fills for the same ASIN on the same day.
const FOUND_COLUMNS = [
  'requested_asin',
  'marketplace',
  'fetch_date',
  'asin',
  'monthly_revenue',
  'monthly_sales',
  'sales_rank',
  'category_title',
  'review_count',
  'reviews_rating',
  'extra_fields',
];

export async function writeFound(rows, marketplace, fetchDate) {
  if (!rows.length) return 0;

  const values = [];
  const tuples = [];
  for (const r of rows) {
    const top = (r.ranks || [])[0] || null;
    const subs = (r.ranks || []).slice(1);

    const vals = [
      r.asin,
      marketplace,
      fetchDate,
      r.panelAsin || r.asin,
      r.revenueCents,
      r.unitSales,
      top ? top.rank : null,
      top ? top.category : null,
      r.reviewCount ?? null,
      r.rating ?? null,
      // Provenance. The research table is otherwise documented as coming from
      // the MCP search_products tool, and a panel row fills only a handful of
      // its columns -- without this, "null" is ambiguous between "the scraper
      // does not collect it" and "Helium 10 had no value".
      JSON.stringify({
        data_source: 'panel_scraper',
        extension_version: r.extensionVersion ?? null,
        listing_health_score: r.listingHealthScore ?? null,
        // Subcategory ranks go here, NOT in subcategories_best_sellers_rank.
        // Existing rows in that column carry {node_id, best_sellers_rank} from
        // the API, and the panel only exposes category *names* -- writing
        // name-keyed objects into it would leave anything reading by node_id
        // silently skipping every scraper row.
        subcategory_ranks: subs.map((x) => ({ category: x.category, rank: x.rank })),
        raw_revenue: r.rawRevenue ?? null,
        raw_units: r.rawUnits ?? null,
        scraped_at: r.scrapedAt ?? null,
      }),
    ];

    const base = values.length;
    tuples.push(`(${vals.map((_, i) => `$${base + i + 1}`).join(', ')})`);
    values.push(...vals);
  }

  const updates = FOUND_COLUMNS
    .filter((c) => !['requested_asin', 'marketplace', 'fetch_date'].includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat('updated_at = NOW()')
    .join(', ');

  const sql =
    `INSERT INTO ${tableName('helium_product_research')} ` +
    `(${FOUND_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')} ` +
    `ON CONFLICT (requested_asin, marketplace, fetch_date) DO UPDATE SET ${updates}`;

  await getPool().query(sql, values);
  return rows.length;
}

// The scraper writes exactly TWO reasons, and the split is the retry decision
// itself -- readable straight off the row, without consulting this file:
//
//   panel_no_data     we read the panel and Helium 10 has no estimate.  FINAL.
//   panel_unresolved  we never got a stable reading.                    RETRIED.
//
// Everything else that used to be a reason -- redirected, dead -- answers the
// same retry question the same way ("no data for this ASIN, and trying again
// will not change that"), so it is a *detail*, not a category. The detail lives
// in error_code, which the table already has. Nothing is lost and the two
// categories stay unambiguous.
//
// Prefixed `panel_` so a scraper miss is always distinguishable from the Go
// sync's 'not_returned' / 'call_failed' in the same column.
export const MissingReason = {
  NO_DATA: 'panel_no_data',
  UNRESOLVED: 'panel_unresolved',
};

// Why a panel_no_data row has no data. Settled either way -- this only says
// which kind of nothing it was.
export const NoDataCode = {
  NO_ESTIMATE: 'no_estimate',        // panel settled on $0 / N/A
  SERVED_OTHER_ASIN: 'served_other_asin', // Amazon returned a different product
  ASIN_DEAD: 'asin_dead',            // product page does not exist
};

// Why a panel_unresolved row was not read. All retryable.
//
// There is deliberately no 'not_attempted' code: an ASIN the run never reached
// gets no row at all. Writing one would claim we tried, and the uploaded CSV is
// already the record of what was asked for.
export const UnresolvedCode = {
  TIMEOUT: 'timeout',                // panel never settled
  BLOCKED: 'blocked',                // bot wall
  SHAPE_UNKNOWN: 'shape_unknown',    // panel rendered but did not parse
  DISCONNECTED: 'disconnected',      // browser died
  LOGGED_OUT: 'logged_out',          // H10 session lost, re-login failed
};

// The complete set this scraper may write. `reason` is plain text with no CHECK
// constraint -- adding one would mean a schema change on a table the Go sync
// shares, and would break that sync the moment it wrote a value we had not
// anticipated. So the guard is at runtime instead: a typo here would otherwise
// write a reason belonging to no category, which is never skipped and never
// retried -- an ASIN that silently disappears from the sweep.
const WRITABLE_REASONS = new Set(Object.values(MissingReason));

export async function writeMissing(entries, marketplace, fetchDate) {
  if (!entries.length) return 0;

  const values = [];
  const tuples = [];
  for (const e of entries) {
    if (!WRITABLE_REASONS.has(e.reason)) {
      throw new Error(
        `refusing to write unknown reason "${e.reason}" for ${e.asin}. ` +
        `The scraper may only write: ${[...WRITABLE_REASONS].join(', ')}`,
      );
    }
    const base = values.length;
    tuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, NOW())`,
    );
    values.push(
      e.asin,
      marketplace,
      fetchDate,
      e.reason,
      e.errorCode ?? null,
      e.errorMessage ? String(e.errorMessage).slice(0, 500) : null,
    );
  }

  const sql =
    `INSERT INTO ${tableName('helium_product_research_missing')} ` +
    `(requested_asin, marketplace, fetch_date, reason, error_code, error_message, updated_at) ` +
    `VALUES ${tuples.join(', ')} ` +
    `ON CONFLICT (requested_asin, marketplace, fetch_date) DO UPDATE SET ` +
    `reason = EXCLUDED.reason, error_code = EXCLUDED.error_code, ` +
    `error_message = EXCLUDED.error_message, updated_at = NOW()`;

  await getPool().query(sql, values);
  return entries.length;
}

// Which of these ASINs were settled recently enough to skip.
//
// "Recently enough" is `skipIfSettledWithinDays` (default 2: today and
// yesterday), not "today" and not "ever". Both extremes are wrong:
//
//   today  -- the original bug. A large sheet cannot finish inside one UTC day,
//             so re-uploading the morning after an interrupted run re-scraped
//             everything already paid for.
//   ever   -- retires an ASIN permanently. The panel reports a 30-day trailing
//             revenue, so the answer goes stale and has to be asked again.
//
// A window resumes an interrupted run for free while still letting the data be
// refreshed later.
//
// Note this also honours the Go sync: an ASIN the MCP connector returned data
// for inside the window has a row in the found table, so the scraper skips it.
export async function existingKeys(asins, marketplace) {
  if (!asins.length) return new Set();
  const days = config.skipIfSettledWithinDays;
  // Only *settled* rows suppress a re-scrape. An unresolved row records that we
  // failed, not an answer, so it must not block a later attempt -- otherwise an
  // ASIN would be offered as backlog and then silently skipped on upload, and
  // never scraped again.
  const sql = `
    SELECT requested_asin FROM ${tableName('helium_product_research')}
     WHERE requested_asin = ANY($1) AND marketplace = $2
       AND fetch_date > CURRENT_DATE - $4::int
    UNION
    SELECT requested_asin FROM ${tableName('helium_product_research_missing')}
     WHERE requested_asin = ANY($1) AND marketplace = $2
       AND reason = ANY($3)
       AND fetch_date > CURRENT_DATE - $4::int`;
  const { rows } = await getPool().query(sql, [
    asins, marketplace, SETTLED_MISSING_REASONS, days,
  ]);
  return new Set(rows.map((r) => r.requested_asin));
}

// A settled answer. The question is closed for this ASIN and no run should ask
// it again. Exactly one value now: redirected and dead folded into
// panel_no_data, where they are distinguished by error_code.
const SETTLED_MISSING_REASONS = ['panel_no_data'];

// Reasons that make an ASIN a scrape candidate:
//   not_returned / call_failed  -- the MCP sync could not get it
//   panel_unresolved            -- WE could not get it (e.g. a throttled IP).
//                                  Deliberately re-offered: on a different
//                                  server or a later run it may well succeed,
//                                  so it must not be a permanent verdict.
//
// 'panel_unresolved_after_retries' used to be listed here and is gone: nothing
// ever wrote it. It was left over from the inline-retry design that was cut, and
// a value nothing writes implies behaviour that does not exist.
const BACKLOG_REASONS = ['not_returned', 'call_failed', 'panel_unresolved'];

// The outstanding backlog: ASINs the MCP sync could not serve and this scraper
// has not settled on ANY date. Read-only visibility -- nothing here starts a
// job. Work is only ever what you upload; see POST /jobs.
//
// The exclusion used to be "settled today", which meant an ASIN scraped
// yesterday reappeared here this morning and the backlog never drained. Measured
// on staging before the fix: 1,877 already-resolved ASINs were being re-offered.
export async function backlogAsins({ marketplace = 'US', limit = 1000 } = {}) {
  const sql = `
    WITH candidates AS (
      SELECT DISTINCT requested_asin AS asin
        FROM ${tableName('helium_product_research_missing')}
       WHERE reason = ANY($1)
    ),
    settled_recently AS (
      SELECT requested_asin AS asin
        FROM ${tableName('helium_product_research')}
       WHERE marketplace = $2 AND fetch_date > CURRENT_DATE - $5::int
      UNION
      SELECT requested_asin AS asin
        FROM ${tableName('helium_product_research_missing')}
       WHERE marketplace = $2 AND reason = ANY($3)
         AND fetch_date > CURRENT_DATE - $5::int
    )
    SELECT c.asin
      FROM candidates c
     WHERE NOT EXISTS (SELECT 1 FROM settled_recently s WHERE s.asin = c.asin)
     ORDER BY c.asin
     LIMIT $4`;
  const { rows } = await getPool().query(sql, [
    BACKLOG_REASONS, marketplace, SETTLED_MISSING_REASONS, limit,
    config.skipIfSettledWithinDays,
  ]);
  return rows.map((r) => r.asin);
}

export async function backlogCount({ marketplace = 'US' } = {}) {
  const sql = `
    WITH candidates AS (
      SELECT DISTINCT requested_asin AS asin
        FROM ${tableName('helium_product_research_missing')}
       WHERE reason = ANY($1)
    ),
    settled_recently AS (
      SELECT requested_asin AS asin
        FROM ${tableName('helium_product_research')}
       WHERE marketplace = $2 AND fetch_date > CURRENT_DATE - $4::int
      UNION
      SELECT requested_asin AS asin
        FROM ${tableName('helium_product_research_missing')}
       WHERE marketplace = $2 AND reason = ANY($3)
         AND fetch_date > CURRENT_DATE - $4::int
    )
    SELECT
      (SELECT COUNT(*) FROM candidates)::bigint AS candidates,
      (SELECT COUNT(*) FROM candidates c
         WHERE NOT EXISTS (SELECT 1 FROM settled_recently s WHERE s.asin = c.asin))::bigint AS outstanding`;
  const { rows } = await getPool().query(sql, [
    BACKLOG_REASONS, marketplace, SETTLED_MISSING_REASONS,
    config.skipIfSettledWithinDays,
  ]);
  return { candidates: Number(rows[0].candidates), outstanding: Number(rows[0].outstanding) };
}

export function loadEnv() {
  try {
    process.loadEnvFile(path.join(config.root, '.env'));
  } catch { /* env may come from the process instead */ }
}
