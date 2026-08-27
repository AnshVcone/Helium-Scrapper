// Reads back what a job wrote, so an insert is confirmed against the database
// rather than trusted from the job counters.
import { loadEnv, getPool, tableName } from './db.js';

loadEnv();

const asins = process.argv.slice(2);
if (!asins.length) {
  console.error('usage: node src/verify.js ASIN [ASIN...]');
  process.exit(1);
}

const found = await getPool().query(
  `SELECT requested_asin, asin, monthly_revenue, monthly_sales, sales_rank,
          category_title, review_count, reviews_rating,
          extra_fields->>'subcategory_ranks'  AS subcategory_ranks,
          extra_fields->>'data_source'        AS data_source,
          extra_fields->>'extension_version'  AS ext_version,
          fetch_date::text AS fetch_date, updated_at
     FROM ${tableName('helium_product_research')}
    WHERE requested_asin = ANY($1) ORDER BY requested_asin`,
  [asins],
);

const missing = await getPool().query(
  `SELECT requested_asin, reason, error_code, error_message, fetch_date::text AS fetch_date, updated_at
     FROM ${tableName('helium_product_research_missing')}
    WHERE requested_asin = ANY($1) ORDER BY requested_asin`,
  [asins],
);

console.log(`=== ${tableName('helium_product_research')} (${found.rowCount}) ===`);
for (const r of found.rows) {
  const rev = r.monthly_revenue == null ? 'null' : `$${(r.monthly_revenue / 100).toLocaleString()}`;
  console.log(
    `${r.requested_asin}  rev=${rev}  units=${r.monthly_sales}  bsr=${r.sales_rank}` +
    `  cat=${r.category_title}  rating=${r.reviews_rating} (${r.review_count})`,
  );
  console.log(`   subs=${r.subcategory_ranks}`);
  console.log(`   source=${r.data_source} ext=${r.ext_version} fetch_date=${r.fetch_date}`);
}

console.log(`\n=== ${tableName('helium_product_research_missing')} (${missing.rowCount}) ===`);
for (const r of missing.rows) {
  console.log(
    `${r.requested_asin}  reason=${r.reason}  code=${r.error_code ?? '-'}  ` +
    `msg=${r.error_message ?? '-'}  fetch_date=${r.fetch_date}`,
  );
}

await getPool().end();
process.exit(0);
