import { NextRequest, NextResponse } from 'next/server'
import { getPayloadInstance } from '@/lib/payload-server'
import { getLocationSlugMap, lookupSlugs } from '@/lib/location-slug-lookup'
import { fetchLeanClinics, num, parseLeanListingFilters } from '@/lib/lean-clinic-listing'
import { RateLimiter, enforceLimit } from '@/lib/rate-limit'
import { cacheListing, getCachedListing, listingCacheKey } from '@/lib/listing-cache'

// Rendered per-request because the result depends entirely on the query string,
// but the RESPONSE is cacheable: no cookie, no session, no user field.
// force-dynamic controls Next's rendering; lib/listing-cache controls reuse.
export const dynamic = 'force-dynamic'

// Public, unauthenticated, hits the 4-connection pool on every call.
// See app/api/city-clinics/route.ts for why this is not optional.
const limiter = new RateLimiter(60, 60 * 1000)

function parsePage(value: string | null): number {
  const n = Number(value ?? '1')
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1
}

function parseLimit(value: string | null): number {
  const n = Number(value ?? '24')
  return Number.isFinite(n) ? Math.min(48, Math.max(12, Math.floor(n))) : 24
}

export async function GET(req: NextRequest) {
  const blocked = await enforceLimit(req, limiter, 'clinics-list')
  if (blocked) return blocked

  const { searchParams } = req.nextUrl

  // Checked before any database work, including the slug lookups, so a hit
  // costs nothing beyond the rate-limit check above.
  const cacheKey = listingCacheKey('clinics-list', searchParams)
  const cached = getCachedListing(cacheKey)
  if (cached) return cached

  const stateCode = searchParams.get('stateCode') ?? ''
  const city = searchParams.get('city') ?? ''
  const page = parsePage(searchParams.get('page'))
  const limit = parseLimit(searchParams.get('limit'))

  const payload = await getPayloadInstance()
  const pool = (payload.db as any).pool

  // Raw SQL instead of payload.find(). payload.find() on 'clinics' joins in
  // EVERY relationship and array field regardless of `depth`, so the old
  // implementation sorted and joined across every matching clinic (tens of
  // thousands, unfiltered) before LIMIT trimmed it to 24. That is the exact
  // pattern that caused the 2026-07-29 outage. See lib/lean-clinic-listing.ts
  // for the full explanation.
  //
  // Behaviour note: the lean query tiebreaks on `created_at DESC, id DESC`
  // after `aggregate_rating_count DESC`. payload.find() had no tiebreak at all.
  // created_at alone was not enough either, since the bulk-imported clinics
  // share one timestamp; the id was added 2026-08-15 after page 2 was seen
  // repeating a row from page 1 on staging. Ordering within a tie group may
  // differ from before, and pagination is now actually stable.
  const [slugMap, res] = await Promise.all([
    getLocationSlugMap(),
    fetchLeanClinics(pool, {
      stateCode: stateCode || undefined,
      cityLike: city || undefined,
      limit,
      offset: (page - 1) * limit,
      // Listing filters run in SQL as of 2026-08-07, so `total` below is the
      // real number of matches, not the unfiltered count.
      ...parseLeanListingFilters(searchParams),
      // The /clinics hero shows states and average rating for the listed set
      // (2026-09-28), so they come back with the count.
      withStats: true,
    }),
  ])

  const clinics = res.rows.map((c) => {
    const s = lookupSlugs(c.city ?? '', c.state ?? '', slugMap)
    return {
      id: String(c.id),
      slug: c.slug,
      citySlug: s.citySlug,
      stateSlug: s.stateSlug,
      clinicName: c.clinic_name,
      tagline: c.tagline ?? null,
      city: c.city ?? '',
      state: c.state ?? '',
      neighborhood: c.neighborhood ?? null,
      // numeric columns arrive from pg as strings — see num() for why. The card
      // calls aggregateRating.toFixed(1), so passing "4.2" through crashes it.
      aggregateRating: num(c.aggregate_rating),
      aggregateRatingCount: num(c.aggregate_rating_count),
      photoUrl: c.photo_url ?? null,
      latitude: Number(c.latitude) || 0,
      longitude: Number(c.longitude) || 0,
      clinicType: c.clinic_type ?? null,
      startingPrice: num(c.starting_price),
      // IDs come back as raw ints from SQL; the response contract is strings.
      brandsOffered: (c.brands_offered ?? []).map((b) => String(b)),
      servicesOffered: (c.services_offered ?? []).map((x) => String(x)),
      // Present only when the caller passed lat/lng. Left off entirely when the
      // clinic is outside the near cutoff, so the card can tell "far away" from
      // "right here" instead of reading a missing value as zero.
      distanceMiles: num(c.distance_miles) ?? undefined,
      // In the near-me ZIP; only near-me rows carry it (2026-09-28).
      inZip: c.in_zip === true ? true : undefined,
      // Providers aren't live yet; DirectoryClinicCard hides this row at 0.
      providerCount: 0,
    }
  })

  return cacheListing(cacheKey, {
    clinics,
    totalDocs: res.totalCount,
    // Near-me only (2026-09-28): how many of totalDocs are in the visitor's ZIP,
    // and, for an empty radius, the first wider rung that has clinics.
    zipCount: res.zipCount,
    ...(res.widerRadius !== undefined ? { widerRadius: res.widerRadius } : {}),
    // Distinct states and average rating of the listed set, for the hero.
    stats: res.stats ?? null,
    hasNextPage: page * limit < res.totalCount,
    page,
  })
}
