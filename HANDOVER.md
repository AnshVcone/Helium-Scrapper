# Handover

Everything a new developer needs to run this, change it safely, and know where the
landmines are. `README.md` is the reference; this is the orientation.

---

## 1. What this is, in one paragraph

Helium 10 has no public API. Its Chrome extension shows a **Product Summary** panel on
Amazon product pages containing **30-Day Revenue** and **Unit Sales**. This service drives a
real browser with that extension installed, reads those two figures, and upserts them into
the same two Postgres tables the Go sync (`vx-3-backend/internal/heliumresearch`) writes to.

It is the **fallback path**, not the primary one. The sanctioned Helium 10 MCP connector is
tried first; this exists for the ASINs MCP cannot serve. If you find yourself scraping an
ASIN MCP could have answered, something upstream is wrong.

## 2. Get it running in ten minutes

```bash
npm install
npx playwright install chromium

cp .env.example .env      # fill H10_EMAIL/H10_PASSWORD + DB_* (see §3)
npm run fetch-ext         # downloads + unpacks the extension into vendor/
npm run dbcheck           # proves the DB is reachable and the tables have the columns
npm run auth              # proves the Helium 10 credentials work
npm run probe B0BCJFJV4W  # proves the panel parses; writes output/probe-*.json
npm run serve             # http://localhost:8090
```

If `probe` prints `OK` with a revenue and a unit count, everything works. If it prints
anything else, §6 tells you what each status means.

`npm run scrape` is the CLI equivalent; it is a **dry run** unless you pass `--db`.

## 3. Configuration

`.env` (gitignored, `chmod 600` — it holds two passwords):

| Key | Notes |
|---|---|
| `H10_EMAIL`, `H10_PASSWORD` | A Helium 10 seat **without 2FA** (2FA cannot be automated) |
| `DB_HOST/PORT/NAME/USER/PASS` | Point at **staging**. Copy from `vx-3-backend/.env` |
| `DB_TABLE_PREFIX` | `dev_az_` — yes, even on staging and prod. Do not guess this |
| `PORT` | Default 8090 |
| `HEADLESS` | `1` for headless. Required in a container |
| `NO_SANDBOX` | `1` in containers only — Chromium will not start as root without it |
| `PANEL_TIMEOUT_MS` | Default 90000. Raise on a slow host before blaming throttling |
| `VALUE_STABILITY_MS` | Default 2500. See §5 — do not lower casually |
| `MAX_CONSECUTIVE_TIMEOUTS` | Default 6. Aborts a run that looks throttled |

## 4. Architecture

```
POST /jobs (CSV)  ──► queue (one job at a time) ──► runner.js
                                                       │
   parseAsins()  ──► ledger check (skip settled) ──►  per ASIN:
                                                       │  goto /dp/ASIN
                                                       │  extract.js  ── guards ──►  status
                                                       ▼
                                        found ──► dev_az_helium_product_research
                                        miss  ──► dev_az_helium_product_research_missing
                                        error ──► panel_unresolved (re-offered by /backlog)
```

| File | Responsibility |
|---|---|
| `src/chrome.js` | Launches Chromium with the extension. **Why Chromium, not Chrome:** see §5.1 |
| `src/auth.js` | Automated Helium 10 sign-in. **The URL matters:** see §5.2 |
| `src/extract.js` | Reads the panel. **All the correctness logic lives here** — §5.3 |
| `src/normalize.js` | Value shapes, `-1` sentinel, money→cents |
| `src/runner.js` | The per-ASIN loop, guards, abort conditions, DB batching |
| `src/db.js` | Pool, upserts, the ledger and backlog queries |
| `src/server.js` | HTTP, job queue, job persistence |
| `public/` | Upload form + status page (no build step, no CDN) |

There is **one** scrape code path (`runner.js`). The CLI and the HTTP service both call it,
so they cannot drift.

## 5. The five things that will waste your day if you don't know them

### 5.1 It must be Chromium, not Chrome
Chrome 137+ removed `--load-extension` from **Chrome-branded** builds. Verified on Chrome
151: the extension list came back empty and `chrome://policy` was blank. The flag still works
in Chromium and Chrome for Testing, and Playwright ships that build — hence
`channel: 'chromium'`. That is not a preference, it is the only reason this can be automated.

Also tried and rejected: the `ExtensionInstallForcelist` enterprise policy. On macOS Chrome
only reads policy from root-owned `/Library/Managed Preferences/`, so a user-level
`defaults write` is silently ignored. It does work on Linux, but vendoring the CRX is simpler
and pins the version.

### 5.2 Signing into the website is not enough
Logging in at `members.helium10.com/user/signin` authenticates the *site* and leaves the
panel still saying *"Please log in to launch the extension tools"*. The extension listens for
the `?type=chrome-extension` flow — **that query parameter is what hands it the session.**

### 5.3 The panel renders in two phases, and the gap will silently corrupt your data
It paints tile **labels** first and the **figures** roughly ten seconds later. Until they
land, the line after `30-Day Revenue` is the *next tile's label*:

```
early:  30-Day Revenue          later:  30-Day Revenue
        Current Rating                  $24,645
                                        Unit Sales:
                                        894
```

A naive read records `"Current Rating"` as revenue. Worse, **two early reads of that label
look perfectly stable**, so a naive stability check passes too. This bug was written and
caught twice during the build.

Three guards, all load-bearing — if you touch `extract.js`, keep all three:

1. Wait for a real product page (`#ASIN` present) before judging anything.
2. Wait for the figures to **stop changing** — 2 identical samples 2.5s apart. One good read
   is not proof; the panel can paint an interim `$0`.
3. **Validate the shape** of what was captured (`looksLikeMoney` / `looksLikeUnits`). This is
   what distinguishes a figure from a label. Checked while sampling *and* at final extraction.

**If no stable, value-shaped reading is obtained, nothing is recorded** — the row becomes
`TIMEOUT`, which is never persisted and is simply tried again.

### 5.4 Amazon silently serves a different ASIN
Requesting `/dp/B00TS72KBI` returned `B07HHCY48X`. Measured at 1 in 10 in earlier
investigation and **7 of 19 on the first real sheet**. Written naively, one product's revenue
lands on another product's row and *nothing in the output looks wrong*.

Guarded twice: against Amazon's `#ASIN` field and against the ASIN the panel itself prints.
Both must stay.

Do **not** assume a redirect is a harmless variation sibling. That theory was tested against
`dev_az_parent_asin` and failed: `B0FGY4F68L → B0FGY7N5KT` share a five-character prefix and
have **different parents**.

### 5.5 `$0` with `N/A` units is not a measured zero
It is the absence of an estimate. Confirmed by watching one panel for 30s (it stays at
`$0 / N/A`) and by Helium 10's own API returning 0/null for the same ASINs. Stored as a real
`0` it sinks every downstream `AVG`. It is recorded as `NO_DATA` with a null revenue; the raw
strings are kept in `extra_fields` so the call stays auditable.

Same family of bug: **`-1` is Helium 10's no-data sentinel**, not a value. `normalize.js`
maps it to `null`.

## 6. Statuses, and what they mean for the database

| Status | Table | Meaning |
|---|---|---|
| `OK` | research | A stable, shape-valid figure was read |
| `NO_DATA` | missing / `panel_no_data` | Panel rendered; no estimate exists |
| `REDIRECTED` | missing / `panel_redirected` | Amazon served another ASIN. **Numbers discarded** |
| `DEAD` | missing / `panel_asin_dead` | Genuine not-found page |
| `TIMEOUT` | **nothing** | No trustworthy reading. Retried later |
| `BLOCKED` | **nothing** | Bot wall. Backs off, then aborts |
| `SHAPE_UNKNOWN` | **nothing** | Panel markup changed — **aborts the run** |
| `NOT_LOGGED_IN` | **nothing** | Re-authenticates and re-reads that ASIN |
| `EXTENSION_MISSING` | **nothing** | Extension not running — aborts |
| `DISCONNECTED` | **nothing** | Browser died — aborts, resumes on restart |

**The invariant that matters:** a transient failure is *never* written to the missing table
during the run. That table means "Helium 10 has no data for this ASIN"; recording our own
timeout there would permanently brand a product as dataless because our run broke.

At the end of a job, anything unresolved is written once as **`panel_unresolved`** — a
deliberately distinct reason, because "we could not read it" is a different claim from
"no estimate exists".

`NO_DATA` vs `SHAPE_UNKNOWN` is the same distinction: the first is a fact about the product,
the second is a bug in `extract.js`, and it stops the run rather than filling a column with
blanks.

## 7. Duplicates, retries and resumption

**The two tables are the ledger.** Before scraping, the runner asks which uploaded ASINs
already have a *settled* row for this `(marketplace, fetch_date)` and drops them. One
mechanism covers three cases: overlapping sheets, re-uploads, and resumption after a crash.

**There are no inline retries, by decision.** A failed ASIN is recorded as
`panel_unresolved` and re-offered by `/backlog`. Retrying in-run re-walks the same pages
under the same conditions; on a 5,000-ASIN sheet that is hours spent re-failing.

> **The subtle rule:** `panel_unresolved` must remain **non-settled** in *both* the skip check
> and `/backlog`. If it ever counts as settled, an ASIN is offered as backlog and then
> silently skipped on upload — listed forever, scraped never.

**Interrupted runs resume themselves.** A job running when the process died is re-queued on
startup from `output/jobs.json`; the ledger means it only pays for what had not settled.
(`restore()` must call `pump()` — forgetting that left restored jobs queued forever.)

## 8. Stateless server hopping

`/backlog` derives outstanding work from the database alone, so a replacement server needs
no CSV and no migrated job file:

```bash
curl localhost:8090/backlog                    # counts
curl -X POST 'localhost:8090/jobs/from-backlog?limit=500'
```

Backlog = ASINs in the missing table with reason `not_returned`, `call_failed` or
`panel_unresolved`, minus anything settled today. Our own failures come back around;
genuine findings do not.

## 9. Deploying

`deploy/setup-ubuntu.sh` provisions a plain Ubuntu VM (Node 22, `npm ci`,
`npx playwright install --with-deps chromium`, vendors the extension, installs the systemd
unit). `--with-deps` is the flag people skip — a bare image lacks the ~60 shared libraries
headless Chromium needs.

`Dockerfile` exists but **has never been built** (no Docker daemon available at build time).
Treat it as unverified.

Do **not** use Cloud Run: the browser profile must persist between runs, or every run
re-authenticates.

## 10. Known gaps — good first tasks

1. **No authentication on the web UI.** Anyone who can reach :8090 can write to the
   database. Needs IAP, basic auth, or a firewall-only rule — undecided.
2. **`Dockerfile` unverified.** Build it and fix what breaks.
3. **No `data_source` column.** Provenance rides in `extra_fields` JSONB
   (`data_source: 'panel_scraper'`). A real additive column on both tables would be cleaner,
   but it is a shared-table schema change.
4. **Redirected ASINs are discarded.** Scraping the *served* ASIN as its own row would
   recover ~37% of a sheet, correctly attributed. Needs a product decision.
5. **No tests.** There is no CI anywhere in these repos, which is exactly why the guards in
   `extract.js` are runtime checks that abort rather than assertions. A unit-test suite over
   `normalize.js` and the panel-text parsing (using the fixtures in `output/probe-*.json`)
   would be cheap and worth having.

## 11. Operational notes

- **Throughput: 12–20s per ASIN**, 3.5–5.5 h per 1,000. Slower than a single-read scraper on
  purpose (§5.3). Backlog was 72,129 ASINs on 2026-08-27 ≈ 10–16 days continuous.
- **Expected hit rate is low and that is not a bug.** On the first real 19-ASIN sheet: 7
  found, 11 no-data, 7 of 19 redirected. The panel reads revenue from the same backend the
  MCP tools do; it only adds public BSR. If an ASIN has no Helium 10 estimate, no amount of
  scraping conjures one.
- **A throttled IP usually shows as rising `TIMEOUT`, not `BLOCKED`.** Amazon often serves a
  degraded page rather than a CAPTCHA. `MAX_CONSECUTIVE_TIMEOUTS` aborts on that. Before
  concluding you are throttled, raise `PANEL_TIMEOUT_MS` — a slow host looks identical.
- **The extension self-updates in the wild but is pinned here** (`vendor/PINNED.json`,
  currently 8.42.2). Panel markup moved 8.42.1 → 8.42.2 in nine days. After running
  `npm run fetch-ext`, always re-run `npm run probe` and confirm the two fields still parse.
- **One job at a time.** The browser is serial; extra uploads queue. Two concurrent jobs
  would double Amazon-facing traffic from one IP.
- **This uses the shared Diamond/Elite Helium 10 account.** Bulk-automating the extension is
  very likely against Helium 10's terms, and suspension would cost the team the extension,
  the MCP integration and five sub-users' access. That risk was accepted knowingly; a
  dedicated seat is the intended fix. Swapping it is a fresh `profile/` and a new `.env`.
