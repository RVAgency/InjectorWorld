import { NextRequest, NextResponse } from 'next/server'
import { searchDirectory } from '@/lib/search-queries'
import { geocode } from '@/lib/geocode'
import { RateLimiter, getIp } from '@/lib/rate-limit'

// Rendered per-request (results depend entirely on query params), but the
// RESPONSE is cacheable: search output is a pure function of the query string
// with no personalization and no cookie dependency. force-dynamic controls
// Next's render behaviour; the Cache-Control below controls the CDN.
export const dynamic = 'force-dynamic'

/**
 * Public, non-personalized search results.
 *
 * s-maxage=60          shared caches (CDN) serve a response for 60s.
 * stale-while-revalidate=300  after that, keep serving the stale copy for up to
 *                      5 more minutes while one request refreshes it in the
 *                      background. A traffic spike on a popular query
 *                      ("botox", "lip filler", a major city) collapses to a
 *                      single database hit per minute instead of one per
 *                      keystroke against the 4-connection pool.
 *
 * `public` is safe here only because this endpoint never varies by user or
 * cookie. Do NOT copy this header onto anything auth-dependent.
 */
const SEARCH_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300'

// 60 searches per IP per minute. Generous for debounced typing.
// Move to Redis before multi-instance — see ROADMAP Phase 12 + docs/DECISIONS.md.
const limiter = new RateLimiter(60, 60 * 1000)

function num(v: string | null): number | undefined {
  if (v == null || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export async function GET(req: NextRequest) {
  if (!(await limiter.check(getIp(req)))) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const sp = req.nextUrl.searchParams
  const q = (sp.get('q') ?? '').trim()
  const treatment = (sp.get('treatment') ?? '').trim()
  const location = (sp.get('location') ?? '').trim()
  const page = num(sp.get('page')) ?? 1
  const limit = Math.min(num(sp.get('limit')) ?? 24, 100) // cap at 100 to prevent full-table pulls
  // Only when the caller asked for one (2026-09-28). Absent, searchDirectory
  // picks it: 25 miles around a place, or the ZIP-first ladder (3, 10, 25, 50)
  // around a ZIP, so this live panel counts what the /search page will show.
  const radiusMiles = num(sp.get('radius'))

  // Coordinates: passed directly, or geocoded from the typed location text.
  let lat = num(sp.get('lat'))
  let lng = num(sp.get('lng'))
  let resolvedLocationLabel: string | undefined

  // "near me" / an explicit address that isn't one of our state names -> geocode.
  // We only geocode when no lat/lng were supplied. A bare state/city name is also
  // handled as text inside searchDirectory, so we only geocode when the caller
  // asked for radius behaviour by passing useGeo=1, OR when lat/lng absent and the
  // location looks like a specific place (handled conservatively below).
  const wantGeo = sp.get('geo') === '1'
  if (lat === undefined && lng === undefined && wantGeo && location) {
    const hit = await geocode(location)
    if (hit) {
      lat = hit.lat
      lng = hit.lng
      resolvedLocationLabel = hit.label
    }
  }

  try {
    const result = await searchDirectory({
      q,
      treatment,
      location,
      lat,
      lng,
      radiusMiles,
      page,
      limit,
      // When geo=1, let searchDirectory geocode a typed ZIP and fall back to a
      // place-name lookup. The live (as-you-type) panel omits geo for speed.
      allowGeocode: wantGeo,
    })
    if (resolvedLocationLabel && !result.locationLabel) {
      result.locationLabel = resolvedLocationLabel
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': SEARCH_CACHE_CONTROL } })
  } catch (err: any) {
    console.error('[api/search] failed:', err?.message ?? err)
    // Errors must never be cached at the edge.
    return NextResponse.json(
      { error: 'Search failed' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
