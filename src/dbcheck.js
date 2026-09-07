// Verifies the connection and that both target tables exist with the columns
// this scraper writes. Run before the first real job.
import { loadEnv, getPool, tableName, ping, dbTarget } from './db.js';

loadEnv();

// Report the resolved target, not the raw DB_* variables -- with SCRAPER_MODE
// in play those are only one of three possible sources, and printing them would
// have shown staging while dev mode connected elsewhere.
const target = dbTarget();
console.log(`MODE=${target.mode}`);
console.log(`host=${target.host}:${target.port} db=${target.database} user=${target.user}`);
console.log(`prefix=${target.tablePrefix || '(none)'}`);

const info = await ping();
console.log(`connected: db=${info.db} user=${info.usr}`);

for (const base of ['helium_product_research', 'helium_product_research_missing']) {
  const t = tableName(base);
  const { rows } = await getPool().query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 ORDER BY ordinal_position`,
    [t],
  );
  if (!rows.length) {
    console.error(`MISSING TABLE: ${t}`);
    continue;
  }
  const cols = new Set(rows.map((r) => r.column_name));
  const need =
    base === 'helium_product_research'
      ? ['requested_asin', 'marketplace', 'fetch_date', 'monthly_revenue', 'monthly_sales',
         'sales_rank', 'review_count', 'reviews_rating', 'subcategories_best_sellers_rank',
         'extra_fields', 'updated_at']
      : ['requested_asin', 'marketplace', 'fetch_date', 'reason', 'error_code',
         'error_message', 'updated_at'];
  const absent = need.filter((c) => !cols.has(c));
  const { rows: cnt } = await getPool().query(`SELECT COUNT(*)::int AS n FROM ${t}`);
  console.log(`${t}: ${rows.length} columns, ${cnt[0].n} rows` +
    (absent.length ? `  MISSING COLUMNS: ${absent.join(', ')}` : '  all needed columns present'));
}

await getPool().end();
process.exit(0);
