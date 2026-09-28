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

function clinicCityName(locationName: string): string {
  return locationName.replace(/\s+city$/i, '').trim()
}

export async function GET(req: NextRequest) {
  const blocked = await enforceLimit(req, limiter, 'service-city-clinics')
  if (blocked) return blocked

  const { searchParams } = req.nextUrl

  // Checked before any database work, including the service and location slug
  // lookups, so a hit costs nothing beyond the rate-limit check above.
  const cacheKey = listingCacheKey('service-city-clinics', searchParams)
  const cached = getCachedListing(cacheKey)
  if (cached) return cached

  const serviceSlug = searchParams.get('serviceSlug')
  const stateSlug = searchParams.get('stateSlug')
  const citySlug = searchParams.get('citySlug')
  const page = parsePage(searchParams.get('page'))
  const limit = parseLimit(searchParams.get('limit'))

  if (!serviceSlug) return NextResponse.json({ error: 'Missing serviceSlug' }, { status: 400 })

  const payload = await getPayloadInstance()
  const pool = (payload.db as any).pool
  const serviceRes = await payload.find({
    collection: 'services',
    where: { slug: { equals: serviceSlug } },
    limit: 1,
    depth: 0,
  })
  const service = serviceRes.docs[0]
  if (!service) return NextResponse.json({ error: 'Service not found' }, { status: 404 })

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
    cityName = clinicCityName(String(cityLoc.name ?? ''))
    stateCode ||= cityLoc.state ?? ''
  }

  // Moved off payload.find() 2026-08-15, for the same reason as the brand
  // route: Payload can express the bounding box of a radius but not distance
  // itself, so it cannot order a listing by how near a clinic is. The comment
  // this replaces argued the matching set was small enough for payload.find();
  // that is still true, and is not the point. The ordering is.
  const listingFilters = parseLeanListingFilters(searchParams)

  const [slugMap, res] = await Promise.all([
    getLocationSlugMap(),
    fetchLeanClinics(pool, {
      relFilter: { path: 'servicesOffered', id: Number(service.id) },
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
