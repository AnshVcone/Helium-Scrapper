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
| `REDIRECTED` | Amazon served a different ASIN. **Row is dropped, not written with numbers.** |
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
uploaded ASINs already have a row for this `(marketplace, fetch_date)` in either
table, and drops them from the queue. That covers three cases with one mechanism:

- **Two sheets sharing an ASIN, same day** — the second upload skips it. Verified:
  a 2-ASIN sheet whose ASINs were already scraped reported
  `scraped=0 skipped=2 of 2 (100%)` and never launched a browser.
- **Re-uploading a sheet to finish an interrupted run** — only the outstanding
  ASINs cost anything.
- **Retrying failures** — transient outcomes are never written to either table,
  so they are absent from the ledger and get picked up again automatically.

This works because a settled outcome always produces a row and a transient one
never does. Skipping on "we tried it" rather than "we settled it" would silently
abandon every timeout.

**No inline retries.** When a job ends, any ASIN it could not read is written to
the missing table as **`panel_unresolved`** with `error_code` set to the last
outcome seen, and the job finishes. Nothing is re-walked in the same run.

That is deliberate. Retrying inline re-visits the same pages under the same
conditions, and on a large sheet that is hours spent re-failing: 1,000 unresolved
ASINs out of 5,000 would add 2-3 hours to produce, most likely, the same 1,000
failures. Instead the failure is recorded once, and `/backlog` re-offers it for a
later run — by which time the IP, the session or the hour has changed, which is
what actually makes a second attempt worth anything.

The list is also written to `output/retry-<jobId>.csv` and served at
`GET /jobs/:id/retry.csv` if you want just that job's misses.

**What makes this safe is that `panel_unresolved` is not a settled outcome.**
Both the skip check and `/backlog` treat it as outstanding, so recording a
failure never suppresses a later attempt. Had the skip check counted it as
settled, an ASIN would be offered as backlog and then silently skipped on
upload — listed forever, scraped never.

**Interrupted runs still resume.** A job that was running when the process died
is re-queued on startup — that is finishing the original work, not retrying
failures. The ledger means the resumed run only pays for ASINs that had not
settled.

## Stateless server hopping

A replacement server needs no CSV and no migrated job file — the two tables know
what has settled, so the outstanding backlog is derived from the database.

```bash
curl localhost:8090/backlog                       # counts
curl 'localhost:8090/backlog.csv?limit=500'       # the list
curl -X POST 'localhost:8090/jobs/from-backlog?limit=500'   # just start working it
```

```json
{ "marketplace": "US", "fetchDate": "2026-08-27",
  "candidates": 72197, "outstanding": 72129 }
```

What counts as backlog:

| Reason | In backlog? | Why |
|---|---|---|
| `not_returned`, `call_failed` | yes | The MCP sync could not get it — the whole point of the scraper |
| `panel_unresolved` | **yes** | *We* could not get it. On a different server it may well succeed, so a give-up must never be a permanent verdict |
| `panel_no_data`, `panel_redirected`, `panel_asin_dead` | no | Settled facts about the product |
| any row in the found table for today | no | Already answered |

That third row is the one that makes server-hopping work: our own failures come
back around, while genuine findings do not.

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

## Where rows go

| Panel outcome | Table | `reason` |
|---|---|---|
| `OK` | `helium_product_research` | — |
| `NO_DATA` | `..._missing` | `panel_no_data` |
| `REDIRECTED` | `..._missing` | `panel_redirected` (+ the ASIN Amazon served) |
| `DEAD` | `..._missing` | `panel_asin_dead` |
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
