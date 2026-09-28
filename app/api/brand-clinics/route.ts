import { NextRequest, NextResponse } from 'next/server'
import { getPayloadInstance } from '@/lib/payload-server'
import { getLocationSlugMap, lookupSlugs } from '@/lib/location-slug-lookup'
import {
  fetchLeanClinics,
  leanRowToListingJson,
  parseLeanListingFilters,
} from '@/lib/lean-clinic-listing'
import { RateLimiter, enforceLimit } from '@/lib/rate-limit'
import { cacheListing, getCachedListing, listingCacheKey } from '@/lib/listing-cache'

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
  const blocked = await enforceLimit(req, limiter, 'brand-clinics')
  if (blocked) return blocked

  const { searchParams } = req.nextUrl

  // Checked before any database work, including the brand and location slug
  // lookups, so a hit costs nothing beyond the rate-limit check above.
  const cacheKey = listingCacheKey('brand-clinics', searchParams)
  const cached = getCachedListing(cacheKey)
  if (cached) return cached

  const brandSlug = searchParams.get('brandSlug')
  const stateSlug = searchParams.get('stateSlug')
  const citySlug = searchParams.get('citySlug')
  const page = parsePage(searchParams.get('page'))
  const limit = parseLimit(searchParams.get('limit'))

  if (!brandSlug) return NextResponse.json({ error: 'Missing brandSlug' }, { status: 400 })

  const payload = await getPayloadInstance()
  const pool = (payload.db as any).pool
  const brandRes = await payload.find({
    collection: 'brands',
    where: { slug: { equals: brandSlug } },
    limit: 1,
    depth: 0,
  })
  const b = brandRes.docs[0]
  if (!b) return NextResponse.json({ error: 'Brand not found' }, { status: 404 })

  let stateCode = ''
  let cityName = ''

  if (stateSlug) {
    const stateRes = await payload.find({
      collection: 'locations',
      where: { and: [{ slug: { equals: stateSlug } }, { kind: { equals: 'state' } }] },
      limit: 1,
      depth: 0,
    })
    const stateLoc = stateRes.docs[0]
    if (!stateLoc) return NextResponse.json({ error: 'State not found' }, { status: 404 })
    stateCode = stateLoc.state ?? ''
  }

  if (citySlug) {
    const cityRes = await payload.find({
      collection: 'locations',
      where: { and: [{ slug: { equals: citySlug } }, { kind: { in: ['city', 'metro'] } }] },
      limit: 1,
      depth: 0,
    })
    const cityLoc = cityRes.docs[0]
    if (!cityLoc) return NextResponse.json({ error: 'City not found' }, { status: 404 })
    cityName = String(cityLoc.name ?? '').replace(/\s+city$/i, '').trim()
    stateCode ||= cityLoc.state ?? ''
  }

  // Moved off payload.find() 2026-08-15. Payload cannot express great-circle
  // distance, so it could only ever apply the bounding BOX of a radius and
  // could not order by distance at all. The IP-located default listing needs
  // exactly that ordering, so this route now runs the same lean SQL the
  // /clinics listing uses, which also drops the per-row relationship joins
  // payload.find() performs regardless of `depth`.
  const listingFilters = parseLeanListingFilters(searchParams)

  const [slugMap, res] = await Promise.all([
    getLocationSlugMap(),
    fetchLeanClinics(pool, {
      relFilter: { path: 'brandsOffered', id: Number(b.id) },
      stateCode: stateCode || undefined,
      cityLike: cityName || undefined,
      limit,
      offset: (page - 1) * limit,
      ...listingFilters,
    }),
  ])

  const clinics = res.rows.map((c) =>
    leanRowToListingJson(c, lookupSlugs(c.city ?? '', c.state ?? '', slugMap)),
  )

  const hasNextPage = page * limit < res.totalCount
  return cacheListing(cacheKey, {
    clinics,
    totalDocs: res.totalCount,
    // Near-me only (2026-09-28). See app/api/clinics-list/route.ts.
    zipCount: res.zipCount,
    ...(res.widerRadius !== undefined ? { widerRadius: res.widerRadius } : {}),
    hasNextPage,
    nextPage: hasNextPage ? page + 1 : null,
  })
}
