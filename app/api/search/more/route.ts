import { NextRequest, NextResponse } from 'next/server'
import {
  readSearchPageRequest,
  searchPageResults,
  SEARCH_PAGE_SIZE,
  SEARCH_RESULT_CAP,
} from '@/lib/search-queries'
import { RateLimiter, getIp } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * "Load more" for the /search page (2026-09-28).
 *
 * Takes the /search page's own query string plus `page`, and reads it with the
 * same readSearchPageRequest the page uses, so page N is always a page of the
 * search the visitor is looking at, listing filters included.
 *
 * Deliberately NOT /api/search. That route is the omnibox's live search (Hero,
 * header), and there `lat`, `lng` and `radius` mean the SEARCH centre, while on
 * the /search page the listing panel writes the same three names for its
 * Distance filter. Sharing one route would have read a Distance filter as a new
 * search centre.
 *
 * no-store: the answer depends only on the url, but /search itself is never
 * cached (an IP-derived location once leaked between visitors through it), and
 * Load more is rare enough that caching buys nothing.
 */
const limiter = new RateLimiter(60, 60 * 1000)

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest) {
  if (!(await limiter.check(getIp(req)))) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: NO_STORE })
  }

  const sp = req.nextUrl.searchParams
  const page = Number(sp.get('page'))
  if (!Number.isInteger(page) || page < 1) {
    return NextResponse.json({ error: 'Invalid page' }, { status: 400, headers: NO_STORE })
  }

  const request = readSearchPageRequest(sp)
  // Nothing to search on, or a page past the deepest one search can rank:
  // an empty page, which the client reads as "no more".
  if (!request.hasQuery || (page - 1) * SEARCH_PAGE_SIZE >= SEARCH_RESULT_CAP) {
    return NextResponse.json({ clinics: [], clinicTotal: 0, page }, { headers: NO_STORE })
  }

  try {
    const result = await searchPageResults(request, page)
    return NextResponse.json(
      { clinics: result.clinics, clinicTotal: result.clinicTotal, page },
      { headers: NO_STORE },
    )
  } catch (err: any) {
    console.error('[api/search/more] failed:', err?.message ?? err)
    return NextResponse.json({ error: 'Search failed' }, { status: 500, headers: NO_STORE })
  }
}
