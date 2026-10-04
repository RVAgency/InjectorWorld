import { NextRequest, NextResponse } from 'next/server'

/**
 * Edge guards for /api/*.
 *
 * Two separate jobs, in order of how much they actually matter:
 *
 *   1. LOCKED_COLLECTIONS — deny anonymous access to the Payload REST endpoints
 *      that expose bulk business data (clinics, providers).
 *   2. NOISY_UAS — cosmetic log filtering. Not security. See the note below.
 *
 * The anonymous limit/depth cap is NOT here any more. It lived here as a URL
 * rewrite and never took effect (Payload reads the original request url, not
 * the rewritten one). It is enforced inside Payload now: lib/anonymous-read-caps.ts.
 *
 * Read the note on each before changing it. In particular, do not treat this
 * file as the enforcement layer for #1: it is the cheap outer gate, and the
 * authoritative check lives in each collection's `access.read`.
 */

/**
 * User agents we drop to keep the logs readable.
 *
 * THIS IS NOT A SECURITY CONTROL. A user agent is a request header that the
 * caller writes, so bypassing this list costs one flag:
 *
 *     curl -A "curl/7.88" .../api/clinics   -> 403
 *     curl -A "Mozilla/5.0" .../api/clinics -> 200
 *
 * It filters out lazy scrapers that never change the default, and nothing more.
 * Never count it as a layer when reasoning about whether a route is protected,
 * and never remove a real control because "the UA filter covers it".
 *
 * Side effect worth knowing: this also blocks your own `curl` while debugging.
 * Pass `-A "Mozilla/5.0"` when testing against a deployed environment.
 */
const NOISY_UAS = [
  'python-requests',
  'Scrapy',
  'scrapy',
  'Go-http-client',
  'libwww-perl',
  'curl/7',
  'wget/',
]

/**
 * Payload auto-generates a REST endpoint for every collection at /api/<slug>,
 * complete with `where`, `sort`, `limit` and `depth` query support. That is a
 * full query interface, not just a read endpoint.
 *
 * Two collections must never be reachable that way by an anonymous caller:
 *
 *   clinics   — ~40k rows carrying business `email` and `phone`. Those emails
 *               are scraped contact data that the product promises not to
 *               publish until an owner claims the profile and opts in
 *               (see the `emailPublic` field in collections/Clinics.ts). The
 *               REST endpoint ignored that promise entirely and served the
 *               address regardless of the flag.
 *   providers — carries `licenseNumber` (a required field) and `email`.
 *
 * Nothing in this application fetches either endpoint. Every page and every
 * client component goes through a purpose-built route instead
 * (/api/clinics-list, /api/city-clinics, /api/clinics/lookup, and so on), so
 * closing these costs no functionality. That was verified by enumerating every
 * `fetch('/api/...')` call site in app/ and components/ before this was added.
 */
const LOCKED_COLLECTIONS = new Set(['clinics', 'providers'])

/**
 * Our own route handlers that happen to sit underneath a locked prefix.
 *
 * Next.js resolves app/api/clinics/lookup/route.ts before Payload's
 * app/(payload)/api/[...slug] catch-all ever sees the request, so these are our
 * code, not Payload's, and they must stay reachable. They do their own
 * validation and rate limiting.
 */
const OWN_ROUTES_UNDER_LOCKED_PREFIX = new Set([
  '/api/clinics/lookup',
  '/api/providers/view',
])

/** Payload's auth cookie. Presence only — see hasSession(). */
const SESSION_COOKIE = 'payload-token'

/**
 * True when the request carries a session cookie at all.
 *
 * DELIBERATELY NOT A VERIFICATION. Middleware runs on the edge runtime without
 * access to the Payload instance, and verifying the JWT here would mean pulling
 * in a signing library and duplicating Payload's own session logic.
 *
 * The consequence is explicit and accepted: sending `Cookie: payload-token=x`
 * with any junk value gets past this file. That is fine, because everything
 * this gate protects is also protected by the collection's `access.read`, which
 * runs inside Payload with a genuinely resolved `req.user` and therefore
 * rejects a forged cookie. This function exists to reject the overwhelmingly
 * common anonymous case cheaply, before a database connection is taken.
 *
 * If you ever move a control so that this function is the ONLY thing standing
 * in front of it, that control is broken. Put it in access control instead.
 */
function hasSession(req: NextRequest): boolean {
  return Boolean(req.cookies.get(SESSION_COOKIE)?.value)
}

/**
 * The collection slug a request targets, or null when the path is not shaped
 * like a Payload collection route.
 *
 * Matches on the path SEGMENT, never on a string prefix. `/api/clinics-list` is
 * one of our own routes and must not be caught by a `startsWith('/api/clinics')`
 * test, which is exactly the bug a prefix match would introduce here.
 */
function collectionSlug(pathname: string): string | null {
  const segments = pathname.split('/')
  // ['', 'api', '<slug>', ...]
  if (segments.length < 3 || segments[1] !== 'api') return null
  return segments[2] || null
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // A NUL byte in a query value is never legitimate, and Postgres refuses it
  // inside a text parameter, so it surfaced as a 500 from /search and every
  // listing API (security sweep, 2026-09-29). Refuse it before a route runs.
  for (const value of req.nextUrl.searchParams.values()) {
    if (value.includes('\u0000')) return new NextResponse('Bad Request', { status: 400 })
  }

  if (!pathname.startsWith('/api/')) return NextResponse.next()

  const ua = req.headers.get('user-agent') || ''
  if (NOISY_UAS.some((s) => ua.includes(s))) {
    return new NextResponse('Forbidden', { status: 403 })
  }

  const signedIn = hasSession(req)
  const slug = collectionSlug(pathname)

  if (
    slug &&
    LOCKED_COLLECTIONS.has(slug) &&
    !OWN_ROUTES_UNDER_LOCKED_PREFIX.has(pathname) &&
    !signedIn
  ) {
    // 404 rather than 403: a 403 confirms the endpoint exists and is merely
    // gated, which tells a prober exactly where to keep pushing.
    return new NextResponse('Not Found', { status: 404 })
  }

  return NextResponse.next()
}

export const config = {
  // /search only for the NUL-byte check above; everything else here is /api.
  matcher: ['/api/:path*', '/search'],
}
