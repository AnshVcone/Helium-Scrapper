// Create the two research tables in the dev database, copying their shape from
// staging.
//
// Why this exists: a dev test run needs somewhere to write, and the trainee DB
// has neither table -- `npm run dbcheck` in dev mode reports both MISSING. The
// scraper only writes 11 of the 74 columns in the found table, but the other 63
// still have to exist, because the upsert names them in its ON CONFLICT clause
// and because a dev run is only a rehearsal if the target looks like the real
// thing.
//
// pg_dump is not installed here, so the DDL is reconstructed from staging's
// catalog: exact types via format_type(), the primary key and unique
// constraints via pg_get_constraintdef(), and the remaining indexes via
// pg_indexes.indexdef.
//
// Reads staging, writes dev. It will not create anything in staging, and it
// refuses to run at all if the two modes resolve to the same host and database
// -- copying a table onto itself is never what anyone meant.
//
//   node scripts/init-dev-tables.mjs           # print the DDL, change nothing
//   node scripts/init-dev-tables.mjs --apply   # create them in dev
import pg from 'pg';
import { loadEnv } from '../src/db.js';

loadEnv();

const apply = process.argv.includes('--apply');
const BASES = ['helium_product_research', 'helium_product_research_missing'];

function envFor(mode) {
  const get = (k) => {
    const scoped = process.env[`${mode.toUpperCase()}_DB_${k}`];
    if (scoped) return scoped;
    // Only staging may fall back to the unprefixed vars; see dbSetting() in db.js.
    return mode === 'staging' ? process.env[`DB_${k}`] : undefined;
  };
  const cfg = {
    host: get('HOST'),
    port: Number(get('PORT') || 5432),
    database: get('NAME'),
    user: get('USER'),
    password: get('PASS'),
    prefix: get('TABLE_PREFIX') || '',
  };
  for (const k of ['host', 'database', 'user']) {
    if (!cfg[k]) throw new Error(`${mode.toUpperCase()}_DB_${k.toUpperCase()} is not set`);
  }
  return cfg;
}

const src = envFor('staging');
const dst = envFor('dev');

console.log(`source (read)  : ${src.user}@${src.host}/${src.database} prefix "${src.prefix}"`);
console.log(`target (write) : ${dst.user}@${dst.host}/${dst.database} prefix "${dst.prefix}"`);

if (src.host === dst.host && src.database === dst.database) {
  console.error('\nRefusing to run: dev and staging resolve to the same host and database.');
  process.exit(1);
}

const mk = (c) => new pg.Pool({
  host: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
  max: 2, connectionTimeoutMillis: 30000,
});

const from = mk(src);
const to = mk(dst);

/** Reconstruct CREATE TABLE + indexes for one table, read off the catalog. */
async function ddlFor(base) {
  const srcName = `${src.prefix}${base}`;
  const dstName = `${dst.prefix}${base}`;

  const { rows: cols } = await from.query(
    `SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS notnull,
            pg_get_expr(d.adbin, d.adrelid) AS def
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [srcName],
  );
  if (!cols.length) throw new Error(`${srcName} not found on staging`);

  const lines = cols.map((c) => {
    // A nextval() default means a sequence-backed column. Recreating the
    // sequence separately is pointless here, so collapse it into serial and let
    // Postgres own the sequence in the target database.
    if (c.def && /^nextval\(/.test(c.def)) {
      const serial = c.type === 'bigint' ? 'bigserial'
        : c.type === 'smallint' ? 'smallserial' : 'serial';
      return `  ${quote(c.name)} ${serial}`;
    }
    let l = `  ${quote(c.name)} ${c.type}`;
    if (c.def) l += ` DEFAULT ${c.def}`;
    if (c.notnull) l += ' NOT NULL';
    return l;
  });

  // Table-level constraints, verbatim from staging. Names are rewritten only
  // where the prefix differs, so the two databases stay comparable.
  const { rows: cons } = await from.query(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = $1::regclass AND contype IN ('p','u','c')
      ORDER BY contype`,
    [srcName],
  );
  for (const c of cons) {
    lines.push(`  CONSTRAINT ${quote(rename(c.name))} ${c.def}`);
  }

  const create = `CREATE TABLE IF NOT EXISTS ${quote(dstName)} (\n${lines.join(',\n')}\n);`;

  // Indexes that are not already implied by a constraint above.
  const conIdx = new Set(cons.map((c) => c.name));
  const { rows: idx } = await from.query(
    `SELECT indexname AS name, indexdef AS def FROM pg_indexes
      WHERE tablename = $1 AND schemaname = 'public'`,
    [srcName],
  );
  const indexes = idx
    .filter((i) => !conIdx.has(i.name))
    .map((i) =>
      i.def
        .replace(/ INDEX (\S+) ON/, ` INDEX IF NOT EXISTS ${quote(rename(i.name))} ON`)
        .replace(
          new RegExp(`(public\\.)?${escapeRe(srcName)}\\b`),
          quote(dstName),
        ) + ';',
    );

  return { srcName, dstName, create, indexes, columnCount: cols.length };
}

const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rename = (n) =>
  src.prefix && dst.prefix && src.prefix !== dst.prefix
    ? n.replace(src.prefix, dst.prefix)
    : n;

let failed = false;
try {
  for (const base of BASES) {
    const d = await ddlFor(base);
    console.log(`\n--- ${d.dstName}  (${d.columnCount} columns, ${d.indexes.length} extra indexes) ---`);

    const { rows: exists } = await to.query('SELECT to_regclass($1) AS t', [d.dstName]);
    if (exists[0].t) {
      console.log('already exists in dev — skipping');
      continue;
    }

    if (!apply) {
      console.log(d.create);
      for (const i of d.indexes) console.log(i);
      continue;
    }

    // One transaction per table: a table without its indexes is a trap, since
    // the upsert relies on the unique constraint to be an upsert at all.
    const client = await to.connect();
    try {
      await client.query('BEGIN');
      await client.query(d.create);
      for (const i of d.indexes) await client.query(i);
      await client.query('COMMIT');
      console.log(`created, with ${d.indexes.length} index(es)`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`FAILED, rolled back: ${e.message}`);
      failed = true;
    } finally {
      client.release();
    }
  }
} finally {
  await from.end().catch(() => {});
  await to.end().catch(() => {});
}

if (!apply) console.log('\nDRY RUN — nothing was created. Re-run with --apply.');
process.exit(failed ? 1 : 0);
