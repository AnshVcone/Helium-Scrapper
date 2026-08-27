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

export function getPool() {
  if (pool) return pool;

  const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS } = process.env;
  if (!DB_HOST || !DB_NAME || !DB_USER) {
    throw new Error('DB_HOST / DB_NAME / DB_USER missing from .env');
  }

  pool = new pg.Pool({
    host: DB_HOST,
    port: Number(DB_PORT || 5432),
    database: DB_NAME,
    user: DB_USER,
    password: DB_PASS,
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });

  // A pool error with no listener takes the process down.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  return pool;
}

export function tableName(base) {
  const prefix = process.env.DB_TABLE_PREFIX || '';
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

// Reasons are scraper-specific so a panel miss is distinguishable from the Go
// sync's 'not_returned' / 'call_failed'.
export const MissingReason = {
  NO_DATA: 'panel_no_data',
  REDIRECTED: 'panel_redirected',
  DEAD: 'panel_asin_dead',
  ERROR: 'panel_error',
  // We could not get a reading. Deliberately distinct from panel_no_data: that
  // means Helium 10 has no estimate, this means we never managed to read one.
  // Conflating them would turn our own failures into apparent facts about the
  // product.
  UNRESOLVED: 'panel_unresolved',
};

export async function writeMissing(entries, marketplace, fetchDate) {
  if (!entries.length) return 0;

  const values = [];
  const tuples = [];
  for (const e of entries) {
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

// Which of these ASINs already have a row for this marketplace/date, in either
// table. The two tables together ARE the ledger of settled work: a terminal
// outcome is written, a transient failure is not. So this one query answers both
// "have we already scraped it today" and "what still needs retrying".
export async function existingKeys(asins, marketplace, fetchDate) {
  if (!asins.length) return new Set();
  // Only *settled* rows suppress a re-scrape. An unresolved row records that we
  // failed, not an answer, so it must not block a later attempt -- otherwise an
  // ASIN would be offered as backlog and then silently skipped on upload, and
  // never scraped again.
  const sql = `
    SELECT requested_asin FROM ${tableName('helium_product_research')}
     WHERE requested_asin = ANY($1) AND marketplace = $2 AND fetch_date = $3
    UNION
    SELECT requested_asin FROM ${tableName('helium_product_research_missing')}
     WHERE requested_asin = ANY($1) AND marketplace = $2 AND fetch_date = $3
       AND reason = ANY($4)`;
  const { rows } = await getPool().query(sql, [
    asins, marketplace, fetchDate, SETTLED_MISSING_REASONS,
  ]);
  return new Set(rows.map((r) => r.requested_asin));
}

// Reasons that represent a real, settled panel reading. A row carrying one of
// these means the question is answered for today and the ASIN should not be
// re-scraped.
const SETTLED_MISSING_REASONS = ['panel_no_data', 'panel_redirected', 'panel_asin_dead'];

// Reasons that make an ASIN a scrape candidate:
//   not_returned / call_failed              -- the MCP sync could not get it
//   panel_unresolved                        -- WE could not get it (e.g. a
//                                              throttled IP). Deliberately
//                                              re-offered: on a different server
//                                              or a later run it may well
//                                              succeed, so it must not be a
//                                              permanent verdict.
const BACKLOG_REASONS = ['not_returned', 'call_failed', 'panel_unresolved', 'panel_unresolved_after_retries'];

// The outstanding backlog, derived entirely from the database. This is what lets
// a replacement server pick up where a previous one left off with no local
// state: no CSV to keep, no job file to migrate.
export async function backlogAsins({ marketplace = 'US', fetchDate, limit = 1000 } = {}) {
  const sql = `
    WITH candidates AS (
      SELECT DISTINCT requested_asin AS asin
        FROM ${tableName('helium_product_research_missing')}
       WHERE reason = ANY($1)
    ),
    settled_today AS (
      SELECT requested_asin AS asin
        FROM ${tableName('helium_product_research')}
       WHERE marketplace = $2 AND fetch_date = $3
      UNION
      SELECT requested_asin AS asin
        FROM ${tableName('helium_product_research_missing')}
       WHERE marketplace = $2 AND fetch_date = $3 AND reason = ANY($4)
    )
    SELECT c.asin
      FROM candidates c
     WHERE NOT EXISTS (SELECT 1 FROM settled_today s WHERE s.asin = c.asin)
     ORDER BY c.asin
     LIMIT $5`;
  const { rows } = await getPool().query(sql, [
    BACKLOG_REASONS, marketplace, fetchDate, SETTLED_MISSING_REASONS, limit,
  ]);
  return rows.map((r) => r.asin);
}

export async function backlogCount({ marketplace = 'US', fetchDate } = {}) {
  const sql = `
    WITH candidates AS (
      SELECT DISTINCT requested_asin AS asin
        FROM ${tableName('helium_product_research_missing')}
       WHERE reason = ANY($1)
    ),
    settled_today AS (
      SELECT requested_asin AS asin
        FROM ${tableName('helium_product_research')}
       WHERE marketplace = $2 AND fetch_date = $3
      UNION
      SELECT requested_asin AS asin
        FROM ${tableName('helium_product_research_missing')}
       WHERE marketplace = $2 AND fetch_date = $3 AND reason = ANY($4)
    )
    SELECT
      (SELECT COUNT(*) FROM candidates)::bigint AS candidates,
      (SELECT COUNT(*) FROM candidates c
         WHERE NOT EXISTS (SELECT 1 FROM settled_today s WHERE s.asin = c.asin))::bigint AS outstanding`;
  const { rows } = await getPool().query(sql, [
    BACKLOG_REASONS, marketplace, fetchDate, SETTLED_MISSING_REASONS,
  ]);
  return { candidates: Number(rows[0].candidates), outstanding: Number(rows[0].outstanding) };
}

export function loadEnv() {
  try {
    process.loadEnvFile(path.join(config.root, '.env'));
  } catch { /* env may come from the process instead */ }
}
