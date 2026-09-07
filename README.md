# Helium 10 panel scraper

Reads **30-Day Revenue** and **Unit Sales** off the Helium 10 extension's
Product Summary panel on Amazon product pages.

This is the fallback path for ASINs the sanctioned Helium 10 MCP connector
cannot serve. MCP first; this second.

Fully unattended: it provisions the extension itself, signs itself in, and runs
headless. No clicks, no enterprise policy, no root.

New here? Read **[HANDOVER.md](HANDOVER.md)** first — it orients you and lists the
landmines. This file is the reference.

## Quick start

```bash
npm install
npx playwright install chromium

cp .env.example .env        # fill H10_EMAIL / H10_PASSWORD
npm run fetch-ext           # download + unpack the extension (pins the version)
npm run auth                # verify the credentials work
vi input/asins.txt          # one ASIN per line
npm run scrape              # add HEADLESS=1 for headless
```

`npm run scrape` is a dry run by default -- it reports what it would write.
Pass `--db` to upsert into Postgres. The HTTP service below always writes.

## The three things that were non-obvious

**1. It must be Chromium, not Chrome.** Chrome 137+ removed `--load-extension`
from *Chrome-branded* builds. Verified on Chrome 151: the extension list came
back empty. The flag still works in Chromium and Chrome for Testing, and
Playwright ships that build — so `channel: 'chromium'` is not a preference, it
is the whole reason this can be automated. Extensions also require
`launchPersistentContext`, and headless works.

The enterprise-policy route (`ExtensionInstallForcelist`) was tried first and
abandoned on macOS: Chrome only honours policy from root-owned
`/Library/Managed Preferences/`, so a user-level `defaults write` is silently
ignored — `chrome://policy` stayed blank. It does work on Linux, but vendoring
the CRX is simpler and pins the version.

**2. Signing into the website is not enough.** `members.helium10.com/user/signin`
authenticates the site but leaves the panel showing *"Please log in to launch
the extension tools"*. The extension listens for the
`?type=chrome-extension` flow — that parameter is what hands it the session.

**3. The panel renders in two phases, and the gap is a correctness trap.** It
paints tile *labels* first and the figures roughly ten seconds later. Until they
land, the line after `30-Day Revenue` is the *next tile's label*:

```
early:  30-Day Revenue          later:  30-Day Revenue
        Current Rating                  $24,645
                                        Unit Sales:
                                        894
```

So a naive read records `"Current Rating"` as the revenue — and two early reads
of it look perfectly stable. Three guards, all of which are load-bearing:

1. **Wait for the page to be a product page** (`#ASIN` present) before judging
   anything, so a slow render is not mistaken for a dead ASIN.
2. **Wait for the figures to stop changing** — `valueStabilitySamples` (2)
   identical reads `valueStabilityMs` (2.5s) apart. A single successful read is
   not proof: the panel can paint an interim `$0` before the real figure.
3. **Validate the shape** of what was captured (`looksLikeMoney` /
   `looksLikeUnits`). This is what separates a figure from a label, and it is
   checked both while sampling and again at final extraction.

**If no stable, value-shaped reading is obtained, nothing is recorded.** The row
becomes `TIMEOUT`, which is never persisted and is simply tried again. Writing
the last thing on screen is precisely how a wrong number, or a false "no data",
reaches the database.

Also note `innerText` carries this label/value structure and `textContent`
destroys it.

Confirmed layout (v8.42.2):

```
Product Summary for "B0BCJFJV4W"
Health & Household
#31,294
Vitamin B12 Supplements
#144
30-Day Revenue
$24,645
Unit Sales:
894
Current Rating
4.6
(813)
...
Version 8.42.2
```

## Row statuses

| Status | Meaning |
|---|---|
| `OK` | Panel rendered, at least one of the two fields had a usable value |
| `NO_DATA` | Panel rendered, no estimate exists for this product |
| `REDIRECTED` | Amazon served a different ASIN. **Numbers are dropped**; the row records `served_other_asin` |
| `DEAD` | ASIN does not exist on Amazon (no `#ASIN` field on the page) |
| `EXTENSION_MISSING` | Extension not loaded — **aborts**, but only on a real product page, and only before any panel has rendered this run |
| `NOT_LOGGED_IN` | Session dropped — re-authenticates from `.env` and re-reads that one ASIN |
| `BLOCKED` | Amazon bot wall — backs off, then aborts |
| `SHAPE_UNKNOWN` | Panel present but markup unrecognised — **aborts the run** |
| `TIMEOUT` | Panel never rendered; transient, retried next run |
| `DISCONNECTED` | Browser died mid-run — **aborts**, retried next run |

`NO_DATA` and `SHAPE_UNKNOWN` are deliberately separate. The first is a fact
about the product. The second is a bug in `src/extract.js`, and it stops the run
rather than quietly filling the column with blanks.

## The failure modes that matter

**Redirect misattribution.** Amazon silently serves a different product for dead
or merged ASINs. Measured at 1 in 10 in the August investigation, and reproduced
on the first test ASIN here: `/dp/B00TS72KBI` served `B07HHCY48X`, a sibling
child of parent `B0D6YGJHSH`. Written naively that puts one product's revenue on
another's row with nothing looking broken. Guarded twice — against Amazon's
`#ASIN` field and against the ASIN the panel itself prints.

**`$0` with `N/A` units is not a measured zero.** It is the absence of an
estimate. Verified by watching one panel for 30s — it stays at `$0 / N/A` rather
than resolving — and Helium 10's API returns 0/null for the same ASINs. Stored
as a real `0` it would sink every downstream `AVG`. Recorded as `NO_DATA` with
null revenue; the raw strings are kept so the call stays auditable.

**Silent markup drift.** The panel moved 8.42.1 → 8.42.2 in nine days. Vendoring
the CRX pins it, so the DOM only changes when someone re-runs `npm run fetch-ext`.
`config.expectedExtensionVersion` is also checked at runtime off the panel
footer, and mismatches warn loudly.

## Data rules (`src/normalize.js`)

- `-1` is Helium 10's no-data sentinel, not a value → `null`. Loaded raw it
  poisons every `SUM` and `AVG`.
- Money is stored as **integer cents**. The two H10 surfaces use the same field
  name for cents and for dollars, 100× apart.
- `N/A`, `-`, empty → `null`. Every numeric column must be nullable; sparse rows
  are normal.
- Panel figures are **parent-level aggregates**. For a child ASIN the number may
  describe the whole variation family, not that child. Resolve the grain before
  loading anywhere.

## Pacing

`config.delayMs` is 4–9s of jitter between ASINs. Page load plus the
wait-for-stable-figures costs **8–11s** (measured), so budget **~12–20s per ASIN,
3.5–5.5 hours per 1,000**.

That is slower than a single-read scraper on purpose. The stability wait is what
stops a label or an interim `$0` being recorded as a figure, and getting no
reading is cheap where recording a wrong one is not. `PANEL_TIMEOUT_MS`
(default 90s) and `VALUE_STABILITY_MS` (2.5s) are the knobs if you need to trade
that back.

The practical ceiling is Amazon's tolerance, not speed.

## Web UI

```bash
npm run dbcheck            # confirm DB reachable + both tables have the columns
npm run serve              # listens on :8090
```

| Page | What it does |
|---|---|
| `/` | Upload form. Counts the ASINs in the chosen file **before** upload and shows the estimated run time, so nobody kicks off a 70k job expecting it to finish over lunch. Shows a live DB-connectivity dot and recent jobs. |
| `/status.html` | Live job status, refreshing every 3s: progress bar, found / no-data / error tiles, the outcome breakdown, rows written to each table, and a Stop button. `?job=<id>` deep-links one job. |

Served by the same Express process from `public/`, with no CDN or external
assets, so it works inside the container with no network egress. Light and dark
both handled.

The status page keeps **errors visually separate from no-data**. A timeout is
our problem and gets retried; `NO_DATA` is a fact about the product. Collapsing
them into one number is how a broken run comes to look like a dataless catalogue.

## HTTP API

| Route | Purpose |
|---|---|
| `POST /jobs` | Upload a CSV of ASINs; starts a job. Returns `202` + `jobId`. |
| `GET /jobs/:id` | Job status and counts. |
| `GET /jobs` | All jobs, newest first. |
| `POST /jobs/:id/stop` | Stop after the ASIN in flight. |
| `GET /health` | DB connectivity. |

```bash
# multipart
curl -F 'file=@asins.csv' localhost:8090/jobs
# or raw body
curl -H 'Content-Type: text/csv' --data-binary @asins.csv localhost:8090/jobs
# optional marketplace (default US)
curl -F 'file=@asins.csv' 'localhost:8090/jobs?marketplace=US'
```

Status response:

```json
{
  "state": "completed",          // queued | running | completed | stopped | failed
  "total": 3, "processed": 3, "percent": 100, "remaining": 0,
  "found": 1, "missing": 2, "errors": 0,
  "insertedFound": 1, "insertedMissing": 2,
  "byStatus": { "OK": 1, "NO_DATA": 1, "REDIRECTED": 1 },
  "rejectedTokens": 7,
  "completed": true, "aborted": null, "error": null
}
```

**One job at a time.** The browser is a serial resource; extra uploads queue.
Running two would double Amazon-facing traffic from one IP, which is the fastest
way to get throttled.

CSV parsing mirrors the Go sync's `PartitionASINs`: tokens must be 10 chars,
alphanumeric, and contain a digit. That last rule is what stops a header like
`parent_asin` reaching the scraper as a fake ASIN. Rejected tokens are counted
and sampled in the response rather than silently dropped.

## Duplicates and retries

**The two tables are the ledger.** Before scraping, the runner asks which of the
uploaded ASINs are already settled — **on any date** — and drops them from the
queue. One rule: *scraped and answered, never again.*

The date used to be part of that question, and it was a real bug. A 5,000-ASIN
sheet takes **17-28 hours**, so a run cannot finish inside one UTC day. Re-upload
the CSV the morning after a blocked run and the check asked "settled *today*?",
got no for everything, and re-scraped 2,000 ASINs that were already paid for.
Measured on staging before the fix, `/backlog` had the same asymmetry and was
re-offering **1,877 already-resolved ASINs**, so the backlog never drained.

Now one mechanism covers every case:

- **Two sheets sharing an ASIN** — the second upload skips it, today or next month.
- **Resuming after a block or a manual stop** — only the outstanding ASINs cost
  anything. Verified across a day boundary: an ASIN settled on 2026-09-01 reports
  `SKIP` when re-checked on 2026-09-02; an unresolved one reports `SCRAPE`.
- **Retrying failures** — `panel_unresolved` is not settled, so it comes back
  automatically.

This works because a settled outcome always produces a row and a transient one
never does. Skipping on "we tried it" rather than "we settled it" would silently
abandon every timeout.

**No inline retries.** When a job ends, any ASIN it **actually opened** and could
not read is written to the missing table as **`panel_unresolved`**, with
`error_code` saying how the read failed, and the job finishes. Nothing is
re-walked in the same run.

ASINs the run never reached get **no row at all**. A run aborted at 2,000 of
5,000 never touched the last 3,000, and recording those as failures claims we
tried pages we never opened. The CSV you re-upload is the record that they are
still owed. (The old code wrote them anyway — the migration deleted the six
`NEVER_ATTEMPTED` rows it had already created.)

That is deliberate. Retrying inline re-visits the same pages under the same
conditions, and on a large sheet that is hours spent re-failing: 1,000 unresolved
ASINs out of 5,000 would add 2-3 hours to produce, most likely, the same 1,000
failures. Instead the failure is recorded once and comes back on the next
upload — by which time the IP, the session or the hour has changed, which is what
actually makes a second attempt worth anything.

The list is also written to `output/retry-<jobId>.csv` and served at
`GET /jobs/:id/retry.csv` if you want just that job's misses.

**What makes this safe is that `panel_unresolved` is not a settled outcome.**
Both the skip check and `/backlog` treat it as outstanding, so recording a
failure never suppresses a later attempt. Had the skip check counted it as
settled, an ASIN would be offered as backlog and then silently skipped on
upload — listed forever, scraped never.

This is the one place where "the scraper already ran on it" is *not* enough to
skip. A throttled IP produces `panel_unresolved` by the hundred, and those ASINs
got nothing because **our** end broke, not because there is nothing there.

**Interrupted runs still resume.** A job that was running when the process died
is re-queued on startup — that is finishing the original work, not retrying
failures. The ledger means the resumed run only pays for ASINs that had not
settled.

## Dev or staging: which database a run writes to

`SCRAPER_MODE` picks the target. **The default is `dev`**, deliberately — an
unconfigured box must not write to the shared staging tables because someone
forgot a variable.

```bash
SCRAPER_MODE=dev      npm run dbcheck   # trainee DB, for rehearsals
SCRAPER_MODE=staging  npm run dbcheck   # the shared DB the Go sync also writes
```

| Mode | Resolves from | Falls back to unprefixed `DB_*`? |
|---|---|---|
| `dev` | `DEV_DB_*` | **No — an error instead** |
| `staging` | `STAGING_DB_*` | Yes, so an older `.env` keeps working |

**That asymmetry is the whole point.** The legacy unprefixed variables point at
staging, so letting dev mode fall back to them would write a "dev test run"
straight into the shared tables — the exact accident the switch exists to
prevent. In dev mode a missing `DEV_DB_HOST` stops the process with an
explanation.

The mode is visible everywhere you might check it: `npm run dbcheck` prints the
resolved target rather than the raw variables, `getPool()` logs it on first
connect, the server banner prints it at boot, and `GET /health` returns it.

```json
{ "ok": true, "mode": "dev", "db": "azaffiliates_office_server_trainee",
  "host": "134.195.138.82", "tablePrefix": "dev_az_", "activeJob": null }
```

### A fresh dev database has no tables

`npm run dbcheck` reports both as `MISSING TABLE`. The scraper writes only 11 of
the 74 columns in the found table, but the rest still have to exist — the upsert
names them, and a rehearsal is only a rehearsal if the target matches the real
thing. `pg_dump` is not required:

```bash
node scripts/init-dev-tables.mjs           # print the DDL, change nothing
node scripts/init-dev-tables.mjs --apply   # create them in dev
```

It reads staging's catalog (exact types via `format_type()`, constraints via
`pg_get_constraintdef()`, indexes via `pg_indexes.indexdef`), rewrites the prefix
if it differs, and creates each table and its indexes in **one transaction** —
a table without its unique index would silently turn every upsert into an
insert. It only ever writes to the dev target, and refuses to run if both modes
resolve to the same host and database.

**Verified end to end:** a row written through `writeMissing()` in dev mode
appeared in the trainee database and **not** in staging.

## The scraper only runs what you upload

**A job's ASIN list comes from your CSV and nowhere else.** There are exactly two
sources — `POST /jobs`, and `restore()` replaying that same list after a restart
— and neither invents work from the database. The database is used only
*subtractively*, to drop ASINs that are already settled.

There is deliberately **no endpoint that starts a job from the backlog**.
`POST /jobs/from-backlog` existed and was removed. The backlog views that remain
are read-only:

```bash
curl localhost:8090/backlog                  # counts
curl 'localhost:8090/backlog.csv?limit=500'  # the list, as a file you may upload
```

```json
{ "marketplace": "US", "candidates": 73997, "outstanding": 70583 }
```

This reverses the 2026-08-27 "no local state" design, in which a replacement
server rebuilt its work list from the DB alone. **The trade is deliberate: a new
box now needs the CSV**, so keep the sheets somewhere you can re-upload from.

### The reason vocabulary

`reason` is plain `text` — no Postgres enum, no CHECK constraint. Two writers
share the column, and the scraper's half is exactly **two values**, chosen so the
retry decision is readable straight off the row:

| Writer | `reason` | Means | `error_code` | Retried? |
|---|---|---|---|---|
| MCP sync | `not_returned` | H10 API returned nothing | — | → by the scraper |
| MCP sync | `call_failed` | H10 API call errored | — | → by the scraper |
| **Scraper** | `panel_no_data` | Read the panel; no estimate exists | `no_estimate` · `served_other_asin` · `asin_dead` | **never — final** |
| **Scraper** | `panel_unresolved` | Never got a stable reading | `timeout` · `blocked` · `shape_unknown` · `disconnected` · `logged_out` | **yes, next upload** |

`panel_redirected` and `panel_asin_dead` used to be separate reasons. They answer
the retry question identically — *no data for this ASIN, and trying again will
not change that* — so they are **details, not categories**, and moved into
`error_code`. Nothing is lost: `error_code = 'served_other_asin'` is still
queryable, which matters while the open question of whether to scrape the
*served* ASIN is unresolved.

Two values were deleted for being written by nothing: `panel_error`, and
`panel_unresolved_after_retries` left over from the inline-retry design that was
cut. A value nothing writes implies behaviour that does not exist.

The two MCP values are **not ours to rename** — 145,659 rows and the Go sync
depend on them.

Since the column is unconstrained text, a typo would write a reason belonging to
no category: never skipped, never retried, an ASIN silently gone from the sweep.
A CHECK constraint would catch it but means a schema change on a shared table,
and would break the Go sync the moment it wrote a value we had not anticipated.
So **the guard is at runtime** — `writeMissing()` refuses any reason outside the
known set. Run `node scripts/migrate-reasons.mjs` (add `--apply` to write) to
fold an older database into this vocabulary; it is idempotent and data-only.

## Throttling detection

A squeezed IP does not reliably produce a CAPTCHA. Amazon often serves a
*degraded* page instead — the product renders but the Helium 10 panel never
populates, which reads as `TIMEOUT`, not `BLOCKED`. So `TIMEOUT` is the earlier
and more reliable signal.

`MAX_CONSECUTIVE_TIMEOUTS` (default 6) aborts the run and sets
`throttleSuspected` on the job. A healthy IP does not fail six pages in a row,
and without this a throttled server would grind through an entire sheet
producing nothing. Remaining ASINs stay unwritten, so they are retried rather
than recorded as dataless.

Verified by forcing it (`PANEL_TIMEOUT_MS=800 MAX_CONSECUTIVE_TIMEOUTS=3`):
the run stopped on the third consecutive timeout. The status page flags this
case differently from other aborts, because it means *move the server* rather
than *fix the code*.

`PANEL_TIMEOUT_MS` is also the knob to raise if a slow VM produces timeouts on
pages that are actually fine — check that before concluding you are throttled.

## Alerts (Zoho Cliq)

Detection above is worthless if nobody is looking. On a sweep measured in days
nobody watches `/status.html`, so a throttled run used to stop and the box then
sat idle in silence. Every condition worth knowing about now posts to a Cliq
channel.

Set `CLIQ_WEBHOOK_URL` in `.env` (channel → Integrations → Incoming Webhook).
**It carries a `zapikey`, so it is a credential** — `.env` only, never a commit.
Leave it blank and the scraper runs exactly as before, logging once that alerts
are off. Test it from the box it will run on:

```bash
npm run notifycheck            # one plain message
npm run notifycheck -- --full  # one of every alert shape
```

That is the deploy-time counterpart to `npm run dbcheck`, and it exists for one
reason: the webhook was proven from an office connection, and whether it works
from a datacenter egress IP is a different question — the kind that is otherwise
answered at 3am by an alert that never arrived.

| Alert | Fires when | Run continues? |
|---|---|---|
| Throttling suspected | `THROTTLE_WARN_AT` (3) consecutive timeouts | yes |
| IP looks throttled | `MAX_CONSECUTIVE_TIMEOUTS` (6) — run aborts | no |
| Bot walls | `maxConsecutiveBlocked` CAPTCHA pages | no |
| Panel markup not recognised | `maxConsecutiveUnknownShape` unparsed panels | no |
| H10 session lost | re-login failed, or no credentials | no |
| Extension not loaded | no launcher on the first page | no |
| Browser died | Playwright context disconnected | no |
| Extension version changed | panel footer ≠ `expectedExtensionVersion` | yes |
| **Job finished** | every terminal state, including failure | — |
| **Idle with work outstanding** | no job for `IDLE_ALERT_HOURS` (3) while the DB still has backlog | — |
| Database unreachable | the idle check cannot reach Postgres | — |
| Service started | boot | — |

Two of those carry the load. The **job-finished report** gives counts, duration,
the abort reason if any, and the backlog still outstanding — so the sweep's
progress arrives without anyone asking for it. The **idle alarm** is the only one
that can catch the failure nobody else sees: a run that aborted at 3am leaves a
healthy process, an empty queue and an untouched backlog, which looks fine by
every other measure. It repeats every `IDLE_REPEAT_HOURS` (6) while the
condition holds, because a single 2am message is easy to miss.

### Message shape

```
<glyph> *<what happened>* at <n>/<total> — <the number that proves it>
→ <what to do>          only when a human must act
<job> · <host>
```

Four lines maximum, and usually two:

```
✅ *Job done* 500/500 · 3h 12m
209 found · 254 no-data · 25 unresolved
Backlog: 71,629
386d7173 · gce-scraper-a

🛑 *Stopped: IP throttled* at 142/500 — 6 timeouts in a row, 358 left unwritten
→ Redeploy on a new IP, then re-upload the CSV
386d7173 · gce-scraper-a
```

These arrive dozens of times over a multi-day sweep, so **anything true of every
alert, or lookup-able here once, is noise** — it trains people to skim, which
defeats the alert. The status breakdown, the per-table write counts and the
rejected-token tally stay on `/status.html`; this channel carries the trigger and
the verb. Actions are one imperative, never an explanation. A run that is still
going carries no action line at all, because "no action needed" is exactly the
text that teaches people to stop reading.

Three rules `src/notify.js` obeys, in order:

1. **It can never break a scrape.** Every path catches and returns `false`. The
   runner wraps the callback again on its side.
2. **It can never stall the loop.** Each request carries a 10s abort timeout,
   and the runner fires events without awaiting them.
3. **It can never spam.** Run events dedupe per job per type — a flapping IP
   sends one message, not one per ASIN. The completion report is exempt: it must
   never be swallowed because a warning went out earlier.

Set `SCRAPER_HOST_LABEL` once there is more than one server. Every message
carries it, and since the IP is the thing you rotate, "which box" is the first
thing you need to know.

## Where rows go

| Panel outcome | Table | `reason` |
|---|---|---|
| `OK` | `helium_product_research` | — |
| `NO_DATA` | `..._missing` | `panel_no_data` |
| `REDIRECTED` | `..._missing` | `panel_no_data` / `served_other_asin` (+ the ASIN Amazon served) |
| `DEAD` | `..._missing` | `panel_no_data` / `asin_dead` |
| everything else | `..._missing` | `panel_unresolved` — recorded once, re-offered by `/backlog`, never retried inline |

That last row is the important one. `TIMEOUT`, `BLOCKED`, `SHAPE_UNKNOWN` and
`DISCONNECTED` are **never** written to the missing table. That table means
"Helium 10 has no data for this ASIN"; recording our own timeout there would
permanently brand a product as dataless because our run broke.

Three details that keep the two writers compatible:

- **Only the columns the panel produces are in the INSERT.** The upsert sets
  `EXCLUDED` for listed columns only, so a scraper row cannot blank the ~60
  columns an MCP row fills for the same ASIN on the same day.
- **`fetch_date` is the UTC date**, matching the Go sync's
  `time.Now().UTC().Format("2006-01-02")` exactly, so the
  `(requested_asin, marketplace, fetch_date)` key lines up.
- **`extra_fields.data_source = 'panel_scraper'`** marks provenance. Without it,
  a null in this table is ambiguous between "the scraper does not collect this"
  and "Helium 10 had no value". Subcategory ranks live there too, *not* in
  `subcategories_best_sellers_rank` — existing rows key that column by
  `node_id`, which the panel does not expose.

## Signing in, and moving the session between machines

**Automated login works until Helium 10 escalates to a reCAPTCHA, and then it
cannot.** Solving it is deliberately out of scope. On a laptop that is a one-off
annoyance; on a headless VM it is a wall, because there is no screen to click.

```bash
npm run login          # opens a real window, credentials pre-filled, and WAITS
```

Unlike `npm run auth` — which reports `CAPTCHA` and exits, closing the window
before you can touch it — this one polls for up to `LOGIN_WAIT_MINUTES` (10)
while you solve the challenge, then closes itself once the session is live.

### The session is portable

Do the sign-in once, anywhere with a display, and carry the result:

```bash
npm run profile:save                      # -> profile-seed.tar.gz  (~220 KB)
scp profile-seed.tar.gz <host>:/opt/helium10-panel-scraper/
# on that host:
npm run profile:load
npm run auth                              # must say "Already signed in"
```

That makes sign-in **once per account instead of once per server**, which matters
because the answer to a blocked IP is "redeploy elsewhere" — otherwise every hop
would need another CAPTCHA on a box with no display.

**The tarball is a credential.** Anyone holding it is signed in as the shared
Diamond/Elite account with no password. It is gitignored and written `0600`.
Move it with `scp`; never through chat, email, or a bucket that outlives the
transfer.

Why an allowlist of 13 paths rather than tarring the profile: the profile is
**780 MB, of which 759 MB is `Cache` and `Code Cache`**. The session is under
1 MB. A denylist would also risk carrying Chromium's `SingletonLock` to a machine
where it is a lie — a stale one makes every future launch abort with *"profile
already in use"*. `profile:load` deletes those defensively.

What travels, and why each is needed: `Local State` (holds the key material the
cookie jar is sealed with — a cookies-only copy is undecryptable), `Cookies`,
`Login Data`, `Preferences`, `Secure Preferences`, `Local Storage`,
`Session Storage`, `IndexedDB`, `Local Extension Settings` (the H10 extension's
own `chrome.storage.local`, where its token lives — without it the panel asks you
to log in again despite a valid cookie jar), `Extension State`/`Rules`/`Scripts`,
and `Web Data`.

This works because Playwright launches with `--use-mock-keychain`, so cookies are
sealed with a fixed key rather than one derived from the macOS Keychain.
**Verified:** a seed extracted into an empty directory on the same machine
restored 266 cookies, 23 of them `helium10.com` with readable values. Whether a
*signed-in* session survives the hop is the one thing only a real transfer can
confirm — `npm run auth` on the target box is that test.

Both scripts refuse to run while a Chromium holds the profile, since reading it
mid-write yields a torn SQLite file and writing under a live browser corrupts it
outright. `profile:load` also refuses to overwrite an existing profile without
`--force`, because the session already there may be the only working one anyone
has.

## Deploying on a plain GCE VM (no Docker)

Docker is optional here — the only stateful thing is the browser profile
directory, which a VM disk handles without a volume mount.

```bash
# on the VM, after copying the repo to /opt/helium10-panel-scraper
sudo bash deploy/setup-ubuntu.sh
# then create /opt/helium10-panel-scraper/.env (chmod 600) and:
sudo systemctl start h10-scraper
sudo -u h10 bash -lc 'cd /opt/helium10-panel-scraper && npm run dbcheck && npm run auth'
journalctl -u h10-scraper -f
```

`deploy/setup-ubuntu.sh` installs Node 22, runs `npm ci`, runs
`npx playwright install --with-deps chromium`, vendors the extension, and
installs `deploy/h10-scraper.service`.

**Machine:** e2-medium (2 vCPU / 4 GB) is comfortable. Chromium plus one page is
the whole workload; e2-small works but leaves little headroom.

**The `--with-deps` flag is the part people miss.** A bare Ubuntu image does not
ship the ~60 shared libraries headless Chromium links against, and without them
the browser fails to launch with an opaque error.

**Three things to get right before it will work:**

1. **Whitelist the VM's IP on the Postgres host.** The staging DB is reached
   over the public internet (host details are in `vx-3-backend/.env`, not here),
   so the VM's egress IP has to be permitted by that host's firewall and
   `pg_hba.conf`. Give the VM a
   static external IP (or route through Cloud NAT) so the allowed address does
   not change on restart. `npm run dbcheck` is the test.
2. **Open port 8090 only to people who need it.** The upload form has no
   authentication — anyone who can reach it can start jobs that write to the
   database. Restrict the firewall rule to your office range, or put it behind a
   reverse proxy with auth. Do **not** expose it to `0.0.0.0/0`.
3. **`.env` must be `chmod 600` and owned by the service user.** It holds the
   Helium 10 password and the staging DB password.

**One risk a VM makes worse, not better:** GCP egress ranges are well-known
datacenter IPs, and Amazon treats them less generously than an office
connection. Expect a higher `BLOCKED` rate than the local runs showed. The
scraper backs off and stops rather than pushing through, so you will see it in
the status breakdown rather than as corrupted data.

## Deploying with Docker

`npm run fetch-ext` is the whole provisioning story — it downloads the CRX from
Google's update service and unpacks it, so a container needs no Web Store, no
policy file and no interactive step. See `Dockerfile`.

Do not run this on Cloud Run. The profile must persist between runs; a fresh
container re-authenticates every time, which is slower and worse for bot
scoring. A small always-on VM with a persistent disk mounted at `profile/` is
the right shape — which is why this does not follow the JungleScout sync's Cloud
Run pattern.
