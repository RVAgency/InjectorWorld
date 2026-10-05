# Staging Environment

Set up 2026-07-25/26. This is the single source of truth for how the staging
environment works, what was changed to make it work, and the gotchas that
will bite the next person. Read this before touching staging deploy, DB, or
env config. Mirrors the structure of `docs/DEPLOYMENT-DIGITALOCEAN.md` (prod).

---

## 1. Why staging exists

To test schema changes, bulk data behavior (pagination, listing performance),
and deploys without touching the production database or production repo.
Founder's ask: a safe place to try things before they hit `injector.world`.

---

## 2. The two-repo split (important, easy to get backwards)

| Remote | Repo | Owner | Used for |
|---|---|---|---|
| `origin` | `RVAgency/InjectorWorld` (was `ReederVogel/InjectorWorld` until 2026-10-03) | Founder's GitHub account | **Production.** DO prod app (`starfish-app` / `injectorworld`) deploys from here. |
| `injector` | `rkumar0101/injector.world` | This developer's GitHub account | **Staging.** DO staging app (`injector-world-staging`) deploys from here. |

Both remotes track the same `main` branch name, but they are **different
repos with different histories** — `injector/main` had ~13 old, unrelated
commits before staging setup (stale "New Feature Integration" history from an
earlier personal working copy). It was force-pushed over with the real
current `main` from `origin` to start staging clean:

```bash
git push injector main:old-main-backup   # safety backup of the old history
git push injector main --force            # overwrite with real current code
```

**To deploy to staging:** commit locally, then `git push injector main`
(force only needed if history has diverged again — normally a plain push is
fine once the two are in sync). **This never touches `origin`/production.**

---

## 3. DO infrastructure (staging)

| Piece | Value |
|---|---|
| App | `injector-world-staging`, region NYC1, project `InjectorWorld` |
| Web service component | `injector-world` (Node buildpack, same build chain as prod) |
| Database component | `dev-db-909727` — started as an App Platform **Dev Database**, converted to a real **Managed Database** (see §4 for why) |
| Managed DB cluster | `app-d61aa1a8-76bb-4a95-9e20-1cc20bc0a2c1`, PostgreSQL 17, Basic (1 GB RAM / 1 vCPU / 10 GiB disk), NYC1, ~$15/mo |
| Media | Not yet set up separately — staging currently shares/omits R2 config; add a dedicated `iw-media-staging`-style bucket before testing media upload flows |
| Source | `rkumar0101/injector.world`, branch `main`, autodeploy on |

Note: the App's bound component `dev-db-909727` and the standalone Managed
Database resource `app-d61aa1a8-...` shown under DO's Databases section are
**the same physical cluster** — just two different logins into it (a
component-scoped user `dev-db-909727`/`dev-db-909727`, and the cluster admin
`doadmin`/`defaultdb`). Don't delete either thinking they're duplicates.

---

## 4. Gotcha: Dev Database doesn't work for this build

DO App Platform's free-with-app "Dev Database" only exposes its connection
string (`DATABASE_URL`) **at runtime, not during the build phase**. This
project runs `db-push` + migrations *inside* `npm run build` (see
`package.json` build script), so a Dev Database can never be reached by the
build — it fails with DNS `ENOTFOUND` on whatever bound-variable hostname DO
injects.

**Fix:** click **Convert to a Managed Database** on the Dev Database's
Settings page (Database Type & Scale section). Data migrates automatically,
the App's existing binding keeps working, and you get a real public hostname
usable at build time (~$15/mo instead of $7/mo).

---

## 5. Gotcha: env var key name

DO's dev-database binding injects the connection string as `DATABASE_URL`.
This codebase reads `process.env.DATABASE_URI` everywhere (see
`lib/db-ssl.ts`) — **not** `DATABASE_URL`. Renaming the env var key in the DO
UI is not enough on its own; once converted to a Managed Database, replace
the bound-variable value entirely with the **literal public connection
string** copied from the database's Connection Details panel. Scope:
**Run and Build Time**.

## 6. Gotcha: SSL CA required at build time too

Same as prod: `DB_SSL_CA` must be set (full PEM from the database's
"Download CA certificate" button), scope **Run and Build Time**. Without it,
`getDbSsl()` in `lib/db-ssl.ts` falls back to `rejectUnauthorized: true` with
no CA and the TLS handshake fails.

## 7. Gotcha: Network Access / Trusted Sources

A newly created or newly converted Managed Database only trusts the App
itself by default. Any connection from outside DO's network — including
**your own local machine running a seed script** — gets `ETIMEDOUT`, not a
clean rejection, which makes it look like a DNS/config problem when it's
actually a firewall problem.

Fix: Database → **Network Access** tab → **Add Trusted Sources** → add your
IP, or (matching the same pragmatic workaround prod uses) the wide-open
range:
```
0.0.0.0/1
128.0.0.0/1
```
(DO rejects literal `0.0.0.0/0`, hence the split.)

---

## 8. Gotcha: fresh-DB migration bug (fixed)

`scripts/migrate-pre-push.sql` had an unguarded
`ALTER TYPE enum_faqs_scope ADD VALUE IF NOT EXISTS 'brand'` — fine on prod
(where the enum already exists from history) but fatal on any **fresh**
database, where the type doesn't exist yet (`type "enum_faqs_scope" does not
exist`). Fixed by wrapping it in a `pg_type` existence check, same pattern as
the two guarded statements right above it. This was a real bug affecting any
future fresh-DB bootstrap, not staging-specific — the fix should make it into
`origin`/production too even though prod's existing DB never hits it.

## 9. Gotcha: stale mock data after a schema rename

`scripts/seed-data.ts`'s mock FAQ rows still used `scope: 'city'`, a value
that was renamed to `'location'` in `collections/FAQs.ts` at some point (see
`enum_faqs_scope` rename in `migrate-pre-push.sql`). The seed script's
`payload.create` calls go through full field validation (unlike raw SQL
migrations), so this threw `ValidationError: The following field is invalid:
Scope` and halted the whole seed run partway through. Fixed by updating the
6 affected rows to `scope: 'location'`.

---

## 10. Baseline seed is clinics-first, providers skipped

`scripts/seed.ts` step 7 (mock Providers) is commented out for this project
phase — staging is being used to load-test the clinic directory/listing
pages, and mock providers add relationship complexity without being needed
for that. Services, brands, locations, authors, medical reviewers, and a
small set of mock clinics still seed normally. Restore the block from git
history if provider-page testing is ever needed.

## 11. Bulk dummy clinics for load testing

`scripts/seed-dummy-clinics.ts` (run via `npm run seed:dummy-clinics`)
generates fake, image-free clinics spread across the 20 locked phase-1
metros (15 real states + DC, real coordinates from `seed-data.ts`),
referencing real seeded Services/Brands, `status: 'published'` so they're
immediately visible. Idempotent — tags every row `clinicId: "dummy-NNNNNN"`
and tops up to `--count` rather than duplicating. Default 3000.

```bash
npm run seed:dummy-clinics                 # 3000 (default)
npm run seed:dummy-clinics -- --count=500  # custom count
```

---

## 12. How to run any local script against staging (instead of prod)

**`.env.local` on this machine points at PRODUCTION by default**, not a local
dev DB (see `project-database-uri-is-production` memory /
`docs/LOCAL-DB-NOTE.md`). To run a script against staging instead:

1. Comment out the existing `DATABASE_URI` and `DB_SSL_CA` lines (don't
   delete — you need them back exactly as-is).
2. Add the staging connection string as `DATABASE_URI`, plus
   `DB_SSL_NO_VERIFY=true` (skips CA pinning for this one-off local
   connection — never set this in the DO App env, only ever locally; see the
   comment in `lib/db-ssl.ts`).
3. Run the script.
4. **Uncomment the original two lines back, delete the temporary ones.**
   Verify `DATABASE_URI` in `.env.local` matches production again before
   walking away from this.

Skipping step 4 means the next `npm run dev`, `npm run seed`, or any other
local script silently targets staging instead of production (annoying but
not dangerous) — or worse, if step 1–2 were fumbled, could target production
when you meant staging. Always double check `DATABASE_URI` after this dance.

## 13. Staging admin login

Created by `npm run seed` (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in
`.env.local`, defaults to `admin@injector.world` / `changeme` if unset).
Change the password after first login — it's a weak default sitting in
plaintext in `.env.local`.

---

## 14. Real production data migrated in (2026-07-26), PII stripped

Staging now mirrors production's real directory data instead of fake seed data.
Done via `pg_dump` (production, read-only) + `pg_restore --clean --if-exists`
(staging, full schema so all relational IDs stay consistent) using the local
PostgreSQL 18 client tools at `C:\Program Files\PostgreSQL\18\bin\` (not on
PATH — use the full path). Production connection string for `pg_dump`: use
the **direct** port/db (`:25060` / `defaultdb`), not the PgBouncer pool alias
(`:25061` / `injector-app-pool`) that `.env.local` uses day-to-day — pg_dump
needs a direct session, not a transaction-pooled one.

**Gotcha: `TRUNCATE ... CASCADE` is dangerous with Payload's schema.** The
first attempt to strip PII ran `TRUNCATE users CASCADE`. Payload relationship
fields like `clinics.claimed_by_id`, `providers.claimed_by_id`,
`guides.approved_by_id`, `news.approved_by_id` are foreign keys into `users`
— CASCADE followed those FKs and silently emptied clinics/guides/news/etc.
along with users. Real data had to be re-restored from the dump a second
time. **Correct way to strip PII without collateral damage:**
1. `UPDATE <table> SET <fk_column> = NULL` for every real-content table with
   an FK into the table you're about to clear (find them first via
   `information_schema.table_constraints` joined to `key_column_usage` /
   `constraint_column_usage`, filtered to `constraint_type = 'FOREIGN KEY'`
   and the target table name).
2. For shared polymorphic join tables (`payload_locked_documents_rels`,
   `payload_preferences_rels`, one row per locked-doc/preference with a
   column per collection), `DELETE ... WHERE <that_table>_id IS NOT NULL`
   instead of touching the whole table.
3. Use plain `DELETE FROM <table>` (not `TRUNCATE`) for the actual PII
   tables. Postgres's `TRUNCATE` refuses to run if *any* FK constraint
   references the table — even with zero matching rows — while `DELETE`
   only cares about actual referencing rows, so once step 1–2 are done,
   `DELETE` succeeds without CASCADE and without needing to also list every
   referencing table in the same statement.

**PII removed after restore:** `users`, `users_rels`, `users_sessions`,
`subscribers`, `bookings`, `claims`, `claim_invites`, `audit_logs`,
`assistant_logs` — all emptied. A fresh staging-only admin
(`admin@injector.world` / `changeme`) was created directly via
`payload.create()` (not `npm run seed`, which would re-add the old mock
clinics/guides/FAQs/promotions on top of the real restored data — those
steps use "already exists → skip" or "always wipe and reseed" logic that
doesn't distinguish real data from seed data).

**Real content preserved:** 17,020 clinics, 2,830 locations, 41,488 ZIP
codes, 35 services, 10 brands, 31 guides, 76 news, 20 FAQs. `providers` and
`promotions` are legitimately 0 — matches production's actual current state
(no providers claimed yet).

The local dump file was deleted from the scratchpad after the migration —
it briefly contained the same real user PII the DB restore did, no reason to
keep it around once the DB-level cleanup was done.

---

## 15. Full env var set (configured 2026-07-26)

All set on the `injector-world` component, App → Settings → Environment Variables.
`NEXT_PUBLIC_*` vars need scope **Run and Build Time** (Next.js inlines them into
the client bundle at build) — easy to get wrong by leaving them Run-only.

| Key | Value / source | Scope |
|---|---|---|
| `DATABASE_URI` | staging Managed DB, public connection string | Run and Build Time |
| `PAYLOAD_SECRET` | random 64-char hex, staging-only | Run and Build Time |
| `DB_SSL_CA` | staging DB's CA cert PEM | Run and Build Time |
| `NEXT_PUBLIC_SITE_URL` | `https://injector-world-staging-zz279.ondigitalocean.app` | Run and Build Time |
| `R2_BUCKET` / `R2_ENDPOINT` / `R2_REGION` / `R2_PUBLIC_URL` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | dedicated DO Spaces bucket (`iw-media-staging`), separate from prod's bucket | Run |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | `1x00000000000000000000AA` (Cloudflare's official always-pass test key) | Run and Build Time |
| `TURNSTILE_SECRET_KEY` | `1x0000000000000000000000000000000AA` (matching test secret) | Run |
| `RESEND_API_KEY` | **intentionally unset** — emails just log to console instead of sending, so nothing real goes out from a test environment | — |
| `ADMIN_EMAIL` | developer's own email | Run |
| `TRUSTED_PROXY_COUNT` | `1`, matches prod | Run |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | same key as local/prod — HTTP-referrer restricted in the Google Cloud console to `injector.world/*`, `www.injector.world/*`, `localhost:3000/*`, and this staging `ondigitalocean.app` origin, so one key works across all three environments | Run and Build Time |
| `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` | same Map ID as local/prod (created in Google Cloud → Map management, no per-environment restriction) | Run and Build Time |
| `GEOCODER` | `nominatim` (free, no key — map rendering moved to Google Maps 2026-08-12, geocoding stayed on Nominatim to avoid a second Google API cost surface) | Run |

Not set (deliberately, low priority for staging): `ASSISTANT_ENABLED` /
`ANTHROPIC_API_KEY` (AI chat assistant), `NEWSLETTER_ADDRESS`, `NEXT_PUBLIC_GTM_ID`
(don't want staging traffic polluting real analytics).

## 16. Known gaps / not yet done

- Region is NYC1 same as prod (good) but instance sizes are the smallest
  tier — don't use staging for performance/load benchmarking beyond basic
  pagination checks.
- Claim/signup email flows will submit fine (Turnstile test key always
  passes) but no email actually sends (`RESEND_API_KEY` unset by design) —
  check server logs to see what would have been sent.
- Media uploads go to the new `iw-media-staging` bucket — confirm it's
  actually created and the four R2_* credential values match before trusting
  upload flows work; this doc records the intent, not a verified-working
  screenshot.
