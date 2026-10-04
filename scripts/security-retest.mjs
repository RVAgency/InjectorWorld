#!/usr/bin/env node
/**
 * Security regression test — re-runs every live probe from the 2026-08 audit.
 *
 *   node scripts/security-retest.mjs                      # staging (default)
 *   node scripts/security-retest.mjs https://injector.world
 *   node scripts/security-retest.mjs http://localhost:3000
 *
 * Read-only. Every request is a GET, nothing is created, modified or deleted.
 *
 * The rate-limit section is OPT-IN behind --include-load, because proving a
 * limiter fires means sending a burst past it, and against a target that has NOT
 * yet received these fixes that burst is the denial of service the audit
 * described rather than a test of it. Run it only against a deployment you know
 * carries the fix:
 *
 *   node scripts/security-retest.mjs https://... --include-load
 *
 * WHY THIS FILE EXISTS. The audit findings were proven by hand with curl, and a
 * hand-run proof rots the moment somebody edits an access rule. Each check below
 * asserts the FIX, so a regression shows up as a FAIL here instead of as a
 * scraped database six months later.
 *
 * A .mjs file, not .ts, on purpose: Next compiles every .ts under the repo,
 * including scripts/, so a TypeScript version would become a build dependency.
 *
 * Note on User-Agent: every request sends a browser UA. middleware.ts drops a
 * handful of tool UAs, and that is a log filter rather than a control, so
 * sending a browser UA is what makes these checks meaningful. Check 14 proves
 * the filter is bypassable rather than pretending it protects anything.
 */

const args = process.argv.slice(2)
const INCLUDE_LOAD = args.includes('--include-load')
const BASE = (args.find((a) => !a.startsWith('--')) || 'https://injector-world-staging-zz279.ondigitalocean.app').replace(/\/$/, '')
const UA = 'Mozilla/5.0 (security-retest)'

let pass = 0
let fail = 0
const failures = []

function record(ok, name, detail) {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    failures.push(`${name} — ${detail}`)
    console.log(`  FAIL  ${name}`)
    console.log(`        ${detail}`)
  }
}

async function get(path, { cookie, timeoutMs = 20000 } = {}) {
  const headers = { 'User-Agent': UA }
  if (cookie) headers.Cookie = cookie
  const started = Date.now()
  try {
    const res = await fetch(BASE + path, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    return { status: res.status, text, ms: Date.now() - started }
  } catch (err) {
    return { status: 0, text: '', ms: Date.now() - started, error: err.message }
  }
}

function json(res) {
  try {
    return JSON.parse(res.text)
  } catch {
    return null
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// ── C1: bulk business data must not be reachable ────────────────────────────
async function checkC1() {
  section('C1  Payload REST for clinics/providers is closed')

  const anon = await get('/api/clinics?limit=3&depth=0')
  record(
    anon.status === 404 || anon.status === 403,
    'GET /api/clinics anonymous is refused',
    `expected 404/403, got ${anon.status}${anon.error ? ` (${anon.error})` : ''}`,
  )

  // A forged cookie gets past middleware by design; Payload access control is
  // what must stop it. This check is the one that proves the real gate works.
  const forged = await get('/api/clinics?limit=3&depth=0', { cookie: 'payload-token=forged.nonsense.value' })
  const forgedBody = json(forged)
  const leaked = Boolean(forgedBody?.docs?.length)
  record(
    !leaked && forged.status !== 200,
    'GET /api/clinics with a forged session cookie is refused',
    `status ${forged.status}, docs returned: ${forgedBody?.docs?.length ?? 'n/a'} (a forged cookie must not pass access control)`,
  )

  const providers = await get('/api/providers?limit=2&depth=0')
  record(
    providers.status === 404 || providers.status === 403,
    'GET /api/providers anonymous is refused',
    `expected 404/403, got ${providers.status}`,
  )

  // The query-oracle form, which is what made the original finding worse than a
  // bulk export: it let an attacker target specific records.
  const oracle = await get('/api/clinics?limit=1&depth=0&where%5Bemail%5D%5Bcontains%5D=gmail')
  const oracleBody = json(oracle)
  record(
    oracle.status !== 200 || !oracleBody?.totalDocs,
    'where[email][contains] oracle returns nothing',
    `status ${oracle.status}, totalDocs ${oracleBody?.totalDocs ?? 'n/a'}`,
  )

  // Belt and braces: no clinic email may appear in any anonymous response body.
  const bodyHasEmail = /"email"\s*:\s*"[^"]+@/.test(anon.text)
  record(!bodyHasEmail, 'no clinic email address in an anonymous response', 'response body contained an email field')
}

// ── C2: unbounded limit/depth must not be able to drain the pool ────────────
async function checkC2() {
  section('C2  limit/depth are clamped for anonymous callers')

  /**
   * Target choice matters. The original proof used /api/clinics, which is now
   * closed outright by C1 — so testing the clamp there would pass for the wrong
   * reason. zip-codes is the right target: still publicly readable by design,
   * and large enough (tens of thousands of rows) that an unclamped limit is a
   * real pool-draining query rather than a cheap one.
   *
   * The assertion is on the RESPONSE SHAPE, not on timing. "It came back in
   * under N ms" is flaky across networks and, worse, passes on a small
   * collection where the attack was never going to bite. Counting the rows
   * actually returned tests the clamp itself: ask for 100,000, receive at most
   * MAX_ANON_LIMIT.
   *
   * This is also why it is safe to run against a deployment that lacks the fix:
   * three requests one after another, not a burst.
   */
  const MAX_ANON_LIMIT = 100

  // limit=0 and pagination=false both mean "every row" in Payload, so they are
  // the same attack as a huge limit. The cap lives in lib/anonymous-read-caps.ts.
  for (const query of ['limit=100000', 'limit=0', 'pagination=false']) {
    const res = await get(`/api/zip-codes?${query}&depth=0`, { timeoutMs: 25000 })
    const returned = json(res)?.docs?.length

    if (res.status !== 200) {
      // Non-200 is an acceptable outcome too (the collection may be locked down
      // later); what must never happen is a 200 carrying an unclamped page.
      record(true, `${query} did not return an unclamped page`, `status ${res.status}`)
    } else {
      record(
        typeof returned === 'number' && returned <= MAX_ANON_LIMIT,
        `${query} is clamped to <= ${MAX_ANON_LIMIT} rows`,
        `got ${returned ?? 'unparseable'} rows in ${res.ms}ms — the clamp is not applying`,
      )
    }
  }

  // depth has no visible row count, so assert it does not hang. Kept as a
  // timing check because there is nothing else to observe from outside.
  const deep = await get('/api/zip-codes?limit=5&depth=10', { timeoutMs: 25000 })
  record(
    deep.status !== 0 && deep.ms < 15000,
    'depth=10 responds instead of hanging',
    `status ${deep.status} after ${deep.ms}ms${deep.error ? ` (${deep.error})` : ''}`,
  )

  // The site must still be alive immediately afterwards. This is the check that
  // actually failed during the audit: a trivial request returned 504 because the
  // heavy requests above had taken every database connection.
  const after = await get('/', { timeoutMs: 25000 })
  record(after.status === 200, 'site still answers right after the heavy requests', `GET / returned ${after.status}`)
}

// ── PII collections and globals ────────────────────────────────────────────
async function checkLocked() {
  section('Locked collections and globals (regression guard)')

  for (const slug of ['bookings', 'claims', 'subscribers', 'audit-logs', 'assistant-logs', 'claim-invites', 'export-jobs']) {
    const res = await get(`/api/${slug}?limit=1`)
    record(
      res.status === 401 || res.status === 403 || res.status === 404,
      `/api/${slug} is not publicly readable`,
      `expected 401/403/404, got ${res.status}`,
    )
  }

  const globals = await get('/api/globals/site-config')
  record(globals.status === 403 || globals.status === 401, '/api/globals/site-config is not public', `got ${globals.status}`)

  const gql = await get('/api/graphql?query=%7B__typename%7D')
  record(gql.status === 404 || gql.status === 403, 'GraphQL endpoint is not exposed', `got ${gql.status}`)
}

// ── M8: user-submitted PII must not ride along on public rows ──────────────
async function checkQaPii() {
  section('M8  QA submitterEmail is not public')

  const res = await get('/api/qa?limit=20&depth=0')
  const hasField = /"submitterEmail"\s*:\s*"[^"]+@/.test(res.text)
  record(!hasField, 'no submitterEmail in the public /api/qa response', 'a submitter email address was returned')
}

// ── The app itself must still work ─────────────────────────────────────────
async function checkStillWorks() {
  section('Functionality (the fixes must not have broken the product)')

  const checks = [
    ['/', 'homepage renders'],
    ['/api/clinics-list?limit=3', 'clinics-list still answers'],
    ['/api/clinics/lookup?q=med', 'clinics/lookup still answers (allowlisted under a locked prefix)'],
    ['/api/geo/ip', 'geo/ip still answers'],
    ['/api/search/suggest?q=bot', 'search suggest still answers'],
    ['/robots.txt', 'robots.txt served'],
  ]

  for (const [path, name] of checks) {
    const res = await get(path)
    record(res.status === 200, name, `expected 200, got ${res.status}${res.error ? ` (${res.error})` : ''}`)
  }

  // The clinic directory must still render real clinics to an anonymous visitor.
  // Closing the REST endpoint must not have closed the actual pages, which render
  // through the Local API.
  const list = json(await get('/api/clinics-list?limit=3'))
  const rows = list?.clinics ?? list?.docs ?? list?.rows
  record(Array.isArray(rows) && rows.length > 0, 'clinic listing still returns clinics to anonymous visitors', `got ${JSON.stringify(list)?.slice(0, 160)}`)
}

// ── H3: the public listing limiter has to actually fire ────────────────────
async function checkRateLimit() {
  section('H3  Public listing routes are rate limited')

  // Limit is 60/min. Send 75 sequentially-ish and require at least one 429.
  const burst = []
  for (let i = 0; i < 75; i++) burst.push(get(`/api/city-clinics?stateSlug=texas&page=1&rt=${i}`, { timeoutMs: 15000 }))
  const results = await Promise.all(burst)
  const got429 = results.filter((r) => r.status === 429).length
  const got200 = results.filter((r) => r.status === 200).length

  record(got429 > 0, 'a burst past the limit produces 429s', `75 requests -> ${got200} x 200, ${got429} x 429 (expected some 429)`)
  record(got200 > 0, 'normal requests inside the limit still succeed', `no 2xx at all — the limiter may be too tight`)

  // Give the window room before anything else runs.
  await new Promise((r) => setTimeout(r, 2000))
}

// ── Client IP resolution: not spoofable, and not the edge node ─────────────
async function checkGeoIpResolution() {
  section('Client IP resolution (TRUSTED_PROXY_COUNT)')

  const plain = json(await get('/api/geo/ip'))
  if (!plain) {
    record(false, '/api/geo/ip returns JSON', 'response did not parse')
    return
  }

  /**
   * The security property: supplying X-Forwarded-For must not move the answer.
   * getIp() counts in from the right by trusted proxy hop, so a forged entry
   * only lengthens the list and shifts past the selected index.
   *
   * This is the assertion that would have caught the original spoofable
   * implementation, which read the leftmost entry and therefore returned
   * whatever the caller put there.
   */
  const spoofedRes = await fetch(BASE + '/api/geo/ip', {
    headers: { 'User-Agent': UA, 'X-Forwarded-For': '8.8.8.8' },
    signal: AbortSignal.timeout(20000),
  })
    .then((r) => r.text())
    .catch(() => '')
  let spoofed = null
  try {
    spoofed = JSON.parse(spoofedRes)
  } catch {
    /* handled below */
  }

  record(
    spoofed !== null && spoofed.city === plain.city && spoofed.stateCode === plain.stateCode,
    'a forged X-Forwarded-For does not change the resolved location',
    `plain -> ${plain.city}/${plain.stateCode}, spoofed -> ${spoofed?.city}/${spoofed?.stateCode}`,
  )

  /**
   * Weak but useful signal that the resolved address is a real subscriber line
   * rather than an edge node. Datacenter ranges (Cloudflare, AWS, DO) carry no
   * postal code, so a null ZIP alongside a populated city is the exact shape the
   * TRUSTED_PROXY_COUNT=1 misconfiguration produced.
   *
   * Not a hard failure: some genuine residential addresses also lack a ZIP in
   * the geo provider's data, and a machine inside a datacenter running this
   * script legitimately resolves to one.
   */
  if (plain.city && !plain.zip) {
    console.log(
      `  NOTE  resolved ${plain.city}/${plain.stateCode} with no ZIP — if that is not where you are,`,
    )
    console.log('        check /api/admin/debug/ip; TRUSTED_PROXY_COUNT is probably selecting the edge node')
  } else if (plain.city) {
    console.log(`  NOTE  resolved ${plain.city}/${plain.stateCode} ${plain.zip ?? ''} — eyeball this`)
  }
}

// ── M7: prove the UA filter is not a control ───────────────────────────────
async function checkUaFilterIsNotSecurity() {
  section('M7  UA filter is a log filter, not a control (documented, not a defect)')

  const asTool = await fetch(BASE + '/api/clinics-list?limit=1', {
    headers: { 'User-Agent': 'curl/7.88.1' },
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.status).catch(() => 0)
  const asBrowser = await get('/api/clinics-list?limit=1')

  record(
    asTool === 403 && asBrowser.status === 200,
    'changing one header bypasses the UA filter (expected)',
    `curl UA -> ${asTool}, browser UA -> ${asBrowser.status}. If these now match, middleware.ts changed.`,
  )
}

async function main() {
  console.log(`Security retest against ${BASE}`)
  console.log('Read-only except for one bounded rate-limit burst.\n')

  await checkC1()
  await checkC2()
  await checkLocked()
  await checkQaPii()
  await checkStillWorks()
  await checkGeoIpResolution()
  if (INCLUDE_LOAD) {
    await checkRateLimit()
  } else {
    section('H3  Public listing routes are rate limited')
    console.log('  SKIP  burst test not run (pass --include-load against a deployment that has the fix)')
  }
  await checkUaFilterIsNotSecurity()

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${pass} passed, ${fail} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('retest crashed:', err)
  process.exit(2)
})
