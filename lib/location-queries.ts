import { cache } from 'react'
import { getPayloadInstance } from './payload-server'
import { getWorthItScore, type WorthItResult } from './worth-it'
import { getFaqPreview, getFaqsForPlace, type FaqRow, type FaqSeeAll } from './faqs/queries'
import { getLocationSlugMap, lookupSlugs, type LocationSlugEntry } from './location-slug-lookup'
import { fetchLeanClinics, leanRowToMapClinicInput } from './lean-clinic-listing'
import { ttlMemo } from './ttl-memo'

// ─── Shared types ────────────────────────────────────────────────────────────

export type DirectoryProvider = {
  id: string
  slug: string
  fullName: string
  credentials: string
  title: string
  profilePhotoUrl?: string
  aggregateRating?: number
  aggregateRatingCount?: number
  startingPrice?: number
  treatments: string[]
  treatmentIds?: string[]
  editorsPick: boolean
  licenseStateCode: string
  licenseNumber: string
  licenseVerificationUrl?: string
  licenseStatus?: string
  acceptsNewPatients: boolean
  offersVirtualConsult: boolean
  languages: string[]
  loyaltyPrograms: string[]
  bio?: string
  updatedAt?: string
  additionalLocationCount: number
  clinic: {
    id: string
    name: string
    slug: string
    citySlug: string
    stateSlug: string
    city: string
    state: string
    neighborhood?: string
    latitude: number
    longitude: number
  }
}

export type DirectoryClinic = {
  id: string
  slug: string
  citySlug: string
  stateSlug: string
  clinicName: string
  tagline?: string
  city: string
  state: string
  neighborhood?: string
  aggregateRating?: number
  aggregateRatingCount?: number
  photoUrl?: string
  latitude: number
  longitude: number
  providerCount: number
  clinicType?: string
  startingPrice?: number
  brandsOffered?: string[]
  servicesOffered?: string[]
  /**
   * Miles from the visitor, set only when the listing was ordered around an
   * IP-located point and this clinic fell inside NEAR_MAX_MILES. Undefined
   * means "unknown", never "zero", so the card must not render 0 miles for it.
   */
  distanceMiles?: number
  /** In the visitor's own ZIP on a near-me listing (2026-09-28). */
  inZip?: boolean
}

export type LocationInfo = {
  id: string
  name: string
  slug: string
  kind: string
  stateCode: string
  /** Slug of the parent state, when known (used for cross-linking to money pages) */
  stateSlug?: string
  latitude?: number
  longitude?: number
  providerCount: number
  isLive: boolean
  noindex: boolean
}

// FAQ rows moved to lib/faqs/queries.ts with the FAQ system (2026-09-13).
// Re-exported so existing imports from here keep working.
export type { FaqRow, FaqSeeAll }
export type ServiceInfo = {
  id: string
  name: string
  slug: string
  tagline?: string
  iconSlug?: string
  category: string
  painIndex?: number
  longevityLabel?: string
  downtimeLabel?: string
  avgPriceFromUsd?: number
  avgPriceToUsd?: number
  priceUnit?: string
}
export type NeighborhoodInfo = { id: string; name: string; slug: string; providerCount: number }

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function mapClinic(c: any, slugMap: Map<string, LocationSlugEntry>, providerCount?: number): DirectoryClinic {
  const slugs = lookupSlugs(c.city ?? '', c.state ?? '', slugMap)
  return {
    id: String(c.id),
    slug: c.slug,
    citySlug: slugs.citySlug,
    stateSlug: slugs.stateSlug,
    clinicName: c.clinicName,
    tagline: c.tagline ?? undefined,
    city: c.city,
    state: c.state,
    neighborhood: c.neighborhood ?? undefined,
    aggregateRating: c.aggregateRating ?? undefined,
    aggregateRatingCount: c.aggregateRatingCount ?? undefined,
    photoUrl: c.clinicPhotoUrls?.[0]?.url ?? undefined,
    latitude: Number(c.latitude) || 0,
    longitude: Number(c.longitude) || 0,
    providerCount: providerCount ?? 0,
    clinicType: c.clinicType ?? undefined,
    startingPrice: c.startingPrice ?? undefined,
    brandsOffered: Array.isArray(c.brandsOffered)
      ? c.brandsOffered.map((b: any) => String(typeof b === 'object' ? b.id : b)).filter(Boolean)
      : [],
    servicesOffered: Array.isArray(c.servicesOffered)
      ? c.servicesOffered.map((s: any) => String(typeof s === 'object' ? s.id : s)).filter(Boolean)
      : [],
    distanceMiles: typeof c.distanceMiles === 'number' ? c.distanceMiles : undefined,
  }
}

function mapService(t: any): ServiceInfo {
  return {
    id: String(t.id),
    name: t.name,
    slug: t.slug,
    tagline: t.tagline ?? undefined,
    iconSlug: t.iconSlug ?? undefined,
    category: t.category ?? '',
    painIndex: t.painIndex ?? undefined,
    longevityLabel: t.longevityLabel ?? undefined,
    downtimeLabel: t.downtimeLabel ?? undefined,
    avgPriceFromUsd: t.avgPriceFromUsd ?? undefined,
    avgPriceToUsd: t.avgPriceToUsd ?? undefined,
    priceUnit: t.priceUnit ?? undefined,
  }
}

function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bNyc\b/g, 'NYC')
    .replace(/\bDc\b/g, 'DC')
    .replace(/\bNj\b/g, 'NJ')
}

function mapLocation(c: any, stateCodeOverride?: string): LocationInfo {
  return {
    id: String(c.id),
    name: toTitleCase(c.name ?? ''),
    slug: c.slug,
    kind: c.kind ?? '',
    stateCode: stateCodeOverride ?? c.state ?? '',
    latitude: c.latitude ?? undefined,
    longitude: c.longitude ?? undefined,
    providerCount: c.providerCount ?? 0,
    isLive: c.isLive === true,
    noindex: c.noindex !== false,
  }
}

// FAQ blocks come from lib/faqs/queries.ts since 2026-09-13. The old helpers
// here fell back from a state or city to general FAQs, which repeated one
// block across ~50 state pages. Place pages now show only FAQs set to that
// place. See docs/FAQ-SYSTEM-2026-09-13.md.

function clinicCityName(locationName: string): string {
  return locationName.replace(/\s+city$/i, '').trim()
}

// ─── City directory — /[service]/[state]/[city] ────────────────────────────

export type CityPricing = {
  avgBotoxPerUnit: number | null
  avgFillerPerSyringe: number | null
  sampleSize: number
}

export type CityDirectoryData = {
  service: ServiceInfo
  city: LocationInfo
  stateLocation: LocationInfo | null
  clinics: DirectoryClinic[]
  neighborhoods: NeighborhoodInfo[]
  faqs: FaqRow[]
  faqSeeAll: FaqSeeAll | null
  totalClinics: number
  relatedBrands: Array<{ id: string; name: string; slug: string }>
  guide: { title: string; slug: string } | null
  nearbyFallback: { label: string; stateSlug: string; citySlug: string } | null
}

/** Largest metro in the same state (by published clinic count) to suggest when a
 * city directory has zero clinics. Real slugs from the locations table, never
 * hand-maintained. Returns null on any lookup failure. */
async function getNearbyFallback(
  payload: any,
  stateCode: string,
  excludeCityName: string,
  slugMap: Map<string, LocationSlugEntry>,
): Promise<{ label: string; stateSlug: string; citySlug: string } | null> {
  if (!stateCode) return null
  try {
    const pool = (payload.db as any).pool
    const r = await pool.query(
      `SELECT MIN(city) AS city, count(*)::int AS n
         FROM clinics
        WHERE status = 'published'
          AND upper(state) = upper($1)
          AND city IS NOT NULL AND city <> ''
          AND lower(city) <> lower($2)
        GROUP BY lower(city)
        ORDER BY count(*) DESC
        LIMIT 1`,
      [stateCode, excludeCityName],
    )
    const row = r.rows[0]
    if (!row) return null
    const slugs = lookupSlugs(row.city, stateCode, slugMap)
    if (!slugs.citySlug || !slugs.stateSlug) return null
    return { label: row.city, stateSlug: slugs.stateSlug, citySlug: slugs.citySlug }
  } catch {
    return null
  }
}

export const getCityDirectory = cache(async function getCityDirectory(
  serviceSlug: string,
  stateSlug: string,
  citySlug: string,
): Promise<CityDirectoryData | null> {
  const payload = await getPayloadInstance()

  const [serviceRes, cityRes, stateRes] = await Promise.all([
    payload.find({ collection: 'services', where: { slug: { equals: serviceSlug } }, limit: 1, depth: 1 }),
    payload.find({ collection: 'locations', where: { and: [{ slug: { equals: citySlug } }, { kind: { in: ['city', 'metro'] } }] }, limit: 1, depth: 0 }),
    payload.find({ collection: 'locations', where: { and: [{ slug: { equals: stateSlug } }, { kind: { equals: 'state' } }] }, limit: 1, depth: 0 }),
  ])

  const service = serviceRes.docs[0]
  const cityLoc = cityRes.docs[0]
  if (!service || !cityLoc) return null

  const guide =
    service.guide && typeof service.guide === 'object'
      ? { title: service.guide.title, slug: service.guide.slug }
      : null

  const stateLoc = stateRes.docs[0] ?? null
  const stateCode: string = (stateLoc as any)?.state ?? cityLoc.state ?? ''
  const cityName: string = clinicCityName(cityLoc.name)
  const pool = (payload.db as any).pool

  const [slugMap, clinicsRes, relatedBrandsRes] = await Promise.all([
    getLocationSlugMap(),
      // fetchLeanClinics, not payload.find (2026-09-25): page 1 now comes from
      // the SAME query and order as this page's "Load more" API. With
      // payload.find sorted by -aggregateRatingCount (NULLS FIRST) the two
      // disagreed, and Load more asked the API for its page 2, so the API's
      // page 1 (the most-reviewed clinics) was never shown on this page:
      // 24 of 24 on /brands/botox/texas and /services/lip-filler/texas.
      // Counts shown on the page still come from their own exact queries.
    fetchLeanClinics(pool, { relFilter: { path: 'servicesOffered', id: Number(service.id) }, stateCode, cityLike: cityName, limit: 24, offset: 0 }),
    payload.find({ collection: 'brands', limit: 100, depth: 0, sort: 'name' }),
  ])

  const clinics: DirectoryClinic[] = clinicsRes.rows.map((row) => mapClinic(leanRowToMapClinicInput(row), slugMap))

  let totalClinics = clinicsRes.totalCount
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM clinics c
         JOIN clinics_rels cr ON cr.parent_id = c.id AND cr.services_id = $1
        WHERE c.status = 'published' AND upper(c.city) = $2 AND upper(c.state) = $3`,
      [service.id, cityName.toUpperCase(), stateCode.toUpperCase()],
    )
    totalClinics = Number(r.rows[0]?.n ?? totalClinics)
  } catch { /* use totalDocs fallback */ }

  const nearbyFallback = clinics.length === 0
    ? await getNearbyFallback(payload, stateCode, cityName, slugMap)
    : null

  const hoodsRes = await payload.find({
    collection: 'locations',
    where: {
      and: [
        { kind: { equals: 'neighborhood' } },
        { parent: { equals: cityLoc.id } },
      ],
    },
    limit: 20,
    sort: 'sortRank',
    depth: 0,
  })
  const neighborhoods: NeighborhoodInfo[] = hoodsRes.docs.map((h: any) => ({
    id: String(h.id),
    name: h.name,
    slug: h.slug,
    providerCount: h.providerCount ?? 0,
  }))

  const faqBlock = await getFaqsForPlace({ locationId: cityLoc.id, serviceId: service.id })

  const relatedBrands = (relatedBrandsRes.docs as any[]).map((b: any) => ({
    id: String(b.id), name: b.name, slug: b.slug,
  }))

  return {
    service: mapService(service),
    city: {
      ...mapLocation(cityLoc, stateCode),
      providerCount: totalClinics,
    },
    stateLocation: stateLoc ? mapLocation(stateLoc, stateCode) : null,
    clinics,
    neighborhoods,
    faqs: faqBlock.faqs,
    faqSeeAll: faqBlock.seeAll,
    totalClinics,
    relatedBrands,
    guide,
    nearbyFallback,
  }
})

// ─── Service pillar ─────────────────────────────────────────────────────────

/** `clinicCount` is the sum of the state's city counts, so the pillar's state
 *  picker can show the same number the city picker one level down shows. Summed
 *  rather than queried: `states` is already derived from `allCities`, so the
 *  numbers are in hand and this costs nothing. */
export type StateEntry = { code: string; name: string; slug: string; clinicCount: number }
export type CityEntry = { name: string; slug: string; providerCount: number; stateCode: string; stateSlug: string }

export type ServicePillarData = {
  service: ServiceInfo & {
    shortDescription?: string
    bodyAreas: string[]
  }
  guide: { title: string; slug: string; lede: string } | null
  topCities: LocationInfo[]
  serviceClinics: DirectoryClinic[]
  faqs: FaqRow[]
  faqSeeAll: FaqSeeAll | null
  worthIt: WorthItResult
  states: StateEntry[]
  allCities: CityEntry[]
  relatedBrands: Array<{ id: string; name: string; slug: string }>
  totalClinics: number
}

export const getServicePillar = cache(async function getServicePillar(serviceSlug: string): Promise<ServicePillarData | null> {
  const payload = await getPayloadInstance()
  const treatRes = await payload.find({
    collection: 'services',
    where: { slug: { equals: serviceSlug } },
    limit: 1,
    depth: 2,
  })
  const t = treatRes.docs[0]
  if (!t) return null

  const pool = (payload.db as any).pool
  const [slugMap, topCitiesRes, serviceClinicsResult, faqBlock, worthIt, statesRes, allCitiesRes, relatedBrandsRes] = await Promise.all([
    getLocationSlugMap(),
    payload.find({ collection: 'locations', where: { kind: { equals: 'metro' } }, limit: 12, sort: 'sortRank', depth: 0 }),
    fetchLeanClinics(pool, { relFilter: { path: 'servicesOffered', id: t.id }, limit: 24, offset: 0 }),
    getFaqPreview({ field: 'services', id: t.id }),
    getWorthItScore(t.name),
    payload.find({ collection: 'locations', where: { kind: { equals: 'state' } }, limit: 60, sort: 'name', depth: 0 }),
    pool.query(
      `SELECT MIN(c.city) AS city, c.state, count(*)::int AS n
         FROM clinics c
         JOIN clinics_rels cr ON cr.parent_id = c.id AND cr.services_id = $1
        WHERE c.status = 'published'
          AND c.city IS NOT NULL AND c.city <> ''
          AND c.state IS NOT NULL AND c.state <> ''
        GROUP BY lower(c.city), c.state
        ORDER BY count(*) DESC`,
      [t.id],
    ),
    payload.find({ collection: 'brands', limit: 100, depth: 0, sort: 'name' }),
  ])

  const serviceClinics: DirectoryClinic[] = serviceClinicsResult.rows
    .map((row) => mapClinic(leanRowToMapClinicInput(row), slugMap))

  const totalClinics = serviceClinicsResult.totalCount

  const guide =
    t.guide && typeof t.guide === 'object'
      ? { title: t.guide.title, slug: t.guide.slug, lede: t.guide.lede }
      : null

  const stateSlugByCode = new Map<string, string>(
    (statesRes.docs as any[]).map((s: any) => [String(s.state ?? '').toUpperCase(), s.slug as string]),
  )

  const allCities: CityEntry[] = (allCitiesRes.rows as any[])
    .map((c: any) => {
      const stateCode = String(c.state ?? '').toUpperCase()
      const slugs = lookupSlugs(c.city ?? '', stateCode, slugMap)
      if (!slugs.citySlug) return null
      return {
        name: c.city,
        slug: slugs.citySlug,
        providerCount: Number(c.n ?? 0),
        stateCode,
        stateSlug: slugs.stateSlug || stateSlugByCode.get(stateCode) || '',
      }
    })
    .filter((c): c is CityEntry => !!c && !!c.stateCode && !!c.stateSlug)

  const clinicsByStateCode = new Map<string, number>()
  for (const c of allCities) {
    clinicsByStateCode.set(c.stateCode, (clinicsByStateCode.get(c.stateCode) ?? 0) + c.providerCount)
  }
  const states: StateEntry[] = (statesRes.docs as any[])
    .map((s: any) => {
      const code = String(s.state ?? '').toUpperCase()
      return { code, name: s.name, slug: s.slug, clinicCount: clinicsByStateCode.get(code) ?? 0 }
    })
    .filter((s) => s.code && clinicsByStateCode.has(s.code))

  const relatedBrands = (relatedBrandsRes.docs as any[]).map((b: any) => ({
    id: String(b.id), name: b.name, slug: b.slug,
  }))

  return {
    service: {
      ...mapService(t),
      shortDescription: t.shortDescription ?? undefined,
      bodyAreas: Array.isArray(t.bodyAreas) ? t.bodyAreas : [],
    },
    guide,
    topCities: topCitiesRes.docs.map((c: any) => ({
      ...mapLocation(c),
      stateSlug: stateSlugByCode.get(String(c.state ?? '').toUpperCase()) ?? '',
    })),
    serviceClinics,
    faqs: faqBlock.faqs,
    faqSeeAll: faqBlock.seeAll,
    worthIt,
    states,
    allCities,
    relatedBrands,
    totalClinics,
  }
})

// ─── Service + state ────────────────────────────────────────────────────────

export type ServiceStateData = {
  service: ServiceInfo
  state: LocationInfo
  cities: StateCityEntry[]
  clinics: DirectoryClinic[]
  faqs: FaqRow[]
  faqSeeAll: FaqSeeAll | null
  totalClinics: number
  relatedBrands: Array<{ id: string; name: string; slug: string }>
}

export const getServiceState = cache(async function getServiceState(
  serviceSlug: string,
  stateSlug: string,
): Promise<ServiceStateData | null> {
  const payload = await getPayloadInstance()

  const [treatRes, stateRes] = await Promise.all([
    payload.find({ collection: 'services', where: { slug: { equals: serviceSlug } }, limit: 1, depth: 0 }),
    payload.find({ collection: 'locations', where: { and: [{ slug: { equals: stateSlug } }, { kind: { equals: 'state' } }] }, limit: 1, depth: 0 }),
  ])

  const service = treatRes.docs[0]
  const stateLoc = stateRes.docs[0]
  if (!service || !stateLoc) return null

  const stateCode: string = stateLoc.state ?? ''
  const pool = (payload.db as any).pool

  const [slugMap, citiesRes, faqBlock, relatedBrandsRes, clinicsRes] = await Promise.all([
    getLocationSlugMap(),
    pool.query(
      `SELECT MIN(c.city) AS city, count(*)::int AS n
         FROM clinics c
         JOIN clinics_rels cr ON cr.parent_id = c.id AND cr.services_id = $1
        WHERE c.status = 'published'
          AND upper(c.state) = $2
          AND c.city IS NOT NULL AND c.city <> ''
        GROUP BY lower(c.city)
        ORDER BY count(*) DESC`,
      [service.id, stateCode.toUpperCase()],
    ),
    getFaqsForPlace({ locationId: stateLoc.id, serviceId: service.id }),
    payload.find({ collection: 'brands', limit: 100, depth: 0, sort: 'name' }),
      // fetchLeanClinics, not payload.find (2026-09-25): page 1 now comes from
      // the SAME query and order as this page's "Load more" API. With
      // payload.find sorted by -aggregateRatingCount (NULLS FIRST) the two
      // disagreed, and Load more asked the API for its page 2, so the API's
      // page 1 (the most-reviewed clinics) was never shown on this page:
      // 24 of 24 on /brands/botox/texas and /services/lip-filler/texas.
      // Counts shown on the page still come from their own exact queries.
    fetchLeanClinics(pool, { relFilter: { path: 'servicesOffered', id: Number(service.id) }, stateCode, limit: 24, offset: 0 }),
  ])

  const cities: StateCityEntry[] = (citiesRes.rows as any[])
    .map((row: any) => {
      const slugs = lookupSlugs(row.city ?? '', stateCode, slugMap)
      if (!slugs.citySlug) return null
      return { name: row.city, slug: slugs.citySlug, clinicCount: Number(row.n ?? 0) }
    })
    .filter((city): city is StateCityEntry => !!city)

  let totalClinics = clinicsRes.totalCount
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM clinics c
         JOIN clinics_rels cr ON cr.parent_id = c.id AND cr.services_id = $1
        WHERE c.status = 'published' AND upper(c.state) = $2`,
      [service.id, stateCode.toUpperCase()],
    )
    totalClinics = Number(r.rows[0]?.n ?? totalClinics)
  } catch { /* use totalDocs fallback */ }

  return {
    service: mapService(service),
    state: mapLocation(stateLoc, stateCode),
    cities,
    clinics: clinicsRes.rows.map((row) => mapClinic(leanRowToMapClinicInput(row), slugMap)),
    faqs: faqBlock.faqs,
    faqSeeAll: faqBlock.seeAll,
    totalClinics,
    relatedBrands: (relatedBrandsRes.docs as any[]).map((b: any) => ({ id: String(b.id), name: b.name, slug: b.slug })),
  }
})

// ─── State hub — /[state] ─────────────────────────────────────────────────────

export type StateHubData = {
  state: LocationInfo
  allCities: StateCityEntry[]
  services: ServiceInfo[]
  brands: Array<{ id: string; name: string; slug: string }>
  clinics: DirectoryClinic[]
  faqs: FaqRow[]
  faqSeeAll: FaqSeeAll | null
  totalClinics: number
}

export type StateCityEntry = { name: string; slug: string; clinicCount: number }

export const getStateHub = cache(async function getStateHub(stateSlug: string): Promise<StateHubData | null> {
  const payload = await getPayloadInstance()

  const stateRes = await payload.find({
    collection: 'locations',
    where: { and: [{ slug: { equals: stateSlug } }, { kind: { equals: 'state' } }] },
    limit: 1, depth: 0,
  })
  const stateLoc = stateRes.docs[0]
  if (!stateLoc) return null

  const stateCode: string = stateLoc.state ?? ''

  const pool = (payload.db as any).pool
  const [slugMap, allCitiesRes, servicesRes, brandsRes, clinicsRes, faqBlock] = await Promise.all([
    getLocationSlugMap(),
    pool.query(
      `SELECT MIN(city) AS city, count(*)::int AS n
         FROM clinics
        WHERE status = 'published'
          AND upper(state) = upper($1)
          AND city IS NOT NULL AND city <> ''
        GROUP BY lower(city)
        ORDER BY count(*) DESC`,
      [stateCode],
    ),
    payload.find({ collection: 'services', limit: 50, depth: 0, sort: 'name' }),
    payload.find({ collection: 'brands', limit: 50, depth: 0, sort: 'name' }),
    fetchLeanClinics(pool, { stateCode, limit: 24, offset: 0 }),
    getFaqsForPlace({ locationId: stateLoc.id }),
  ])

  const clinics: DirectoryClinic[] = clinicsRes.rows
    .map((row) => mapClinic(leanRowToMapClinicInput(row), slugMap))

  // fetchLeanClinics returns the exact count for the same WHERE clause, so the
  // number on the page and the rows on the page can no longer disagree. This
  // replaces a second count query that used upper(state) while the listing
  // query used state.
  const totalClinics = clinicsRes.totalCount

  const allCities: StateCityEntry[] = (allCitiesRes.rows as any[])
    .map((row: any) => {
      const slugs = lookupSlugs(row.city ?? '', stateCode, slugMap)
      if (!slugs.citySlug) return null
      return {
        name: row.city,
        slug: slugs.citySlug,
        clinicCount: Number(row.n ?? 0),
      }
    })
    .filter((city): city is StateCityEntry => !!city)

  return {
    state: mapLocation(stateLoc, stateCode),
    allCities,
    services: servicesRes.docs.map((t: any) => mapService(t)),
    brands: (brandsRes.docs as any[]).map((b: any) => ({ id: String(b.id), name: b.name, slug: b.slug })),
    clinics,
    faqs: faqBlock.faqs,
    faqSeeAll: faqBlock.seeAll,
    totalClinics,
  }
})

// ─── City hub — /[state]/[city] ───────────────────────────────────────────────

export type CityHubData = {
  city: LocationInfo
  stateLocation: LocationInfo | null
  services: ServiceInfo[]
  brands: Array<{ id: string; name: string; slug: string }>
  clinics: DirectoryClinic[]
  neighborhoods: NeighborhoodInfo[]
  faqs: FaqRow[]
  faqSeeAll: FaqSeeAll | null
  totalClinics: number
  /**
   * Every published clinic in the city, name and slug only, for the plain link
   * index at the bottom of the page.
   *
   * The card grid stops at 24 rows behind a JS "Load more", so 17,585 clinics
   * (30.5% of the directory) had no crawlable link anywhere on the site. This
   * list is how a crawler reaches the rest. Every clinic belongs to exactly one
   * city, so covering this page covers the whole directory with no new urls and
   * no pagination. See docs/SEO-PATHS-PLAN-2026-09-07.md, Task 3.
   */
  allClinicLinks: Array<{ slug: string; name: string }>
}

export const getCityHub = cache(async function getCityHub(
  stateSlug: string,
  citySlug: string,
): Promise<CityHubData | null> {
  const payload = await getPayloadInstance()

  const [stateRes, cityRes] = await Promise.all([
    payload.find({
      collection: 'locations',
      where: { and: [{ slug: { equals: stateSlug } }, { kind: { equals: 'state' } }] },
      limit: 1, depth: 0,
    }),
    payload.find({
      collection: 'locations',
      where: { and: [{ slug: { equals: citySlug } }, { kind: { in: ['city', 'metro'] } }] },
      limit: 1, depth: 0,
    }),
  ])

  const stateLoc = stateRes.docs[0] ?? null
  const cityLoc = cityRes.docs[0]
  if (!cityLoc) return null

  const stateCode: string = (stateLoc as any)?.state ?? cityLoc.state ?? ''
  const cityName: string = clinicCityName(cityLoc.name)
  const pool = (payload.db as any).pool

  const [slugMap, servicesRes, brandsRes, hoodsRes, clinicsRes, faqBlock, allClinicLinks] = await Promise.all([
    getLocationSlugMap(),
    payload.find({ collection: 'services', limit: 50, depth: 0, sort: 'name' }),
    payload.find({ collection: 'brands', limit: 50, depth: 0, sort: 'name' }),
    payload.find({
      collection: 'locations',
      where: { and: [{ kind: { equals: 'neighborhood' } }, { parent: { equals: cityLoc.id } }] },
      limit: 20, sort: 'sortRank', depth: 0,
    }),
    /**
     * Lean SQL, not payload.find (2026-09-19). Same query the /api/city-clinics
     * load-more endpoint now runs, so page 1 and page 2 share one total order
     * and a clinic can no longer sit on both or fall between them. `cityLike`
     * compiles to `c.city ILIKE $n` with no wildcards, an exact
     * case-insensitive match, which keeps the 2026-09-07 fix that stopped
     * /ohio/cleveland-oh pulling in Cleveland Heights.
     */
    fetchLeanClinics(pool, { stateCode, cityLike: cityName, limit: 24, offset: 0 }),
    // No fallback to the state's FAQs: that repeated one block on every city.
    getFaqsForPlace({ locationId: cityLoc.id }),
    /**
     * Raw SQL, two columns, deliberately not payload.find: payload.find joins in
     * every relationship and array field on clinics regardless of depth, and
     * this is a hot ISR page that can pull 450+ rows here.
     *
     * Predicates mirror the card query above and the totalClinics count below
     * exactly, so all three agree. Plain `=`, NOT `upper(city) = upper($1)`:
     * wrapping the column in a function makes clinics_city_idx unusable and
     * turns this into a sequential scan. Measured on staging: 2,008 ms with
     * upper(), 26 ms without. Safe because every one of the 5,455 city/state
     * pairs matches on exact case (verified 2026-09-07) and every state value
     * is uppercase.
     *
     * LIMIT 1000 is a safety valve against future data growth, not a design
     * cap: the largest city today is Houston at 454.
     */
    pool.query(
      `SELECT slug, clinic_name FROM clinics
        WHERE status = 'published'
          AND city = $1 AND state = $2
          AND slug IS NOT NULL AND slug <> ''
        ORDER BY clinic_name
        LIMIT 1000`,
      [cityName, stateCode],
    ).then(
      (r: any) => (r.rows as any[]).map((row) => ({ slug: row.slug as string, name: row.clinic_name as string })),
      // A failure here must not take the page down. An empty link index is a
      // degraded page, a thrown error is a crashed ISR revalidation.
      () => [] as Array<{ slug: string; name: string }>,
    ),
  ])

  const clinics: DirectoryClinic[] = clinicsRes.rows
    .map((row) => mapClinic(leanRowToMapClinicInput(row), slugMap))

  // Exact count for the same WHERE clause. Replaces the separate count query,
  // so the card grid, the count pill and allClinicLinks cannot drift apart.
  const totalClinics = clinicsRes.totalCount

  return {
    city: { ...mapLocation(cityLoc, stateCode), providerCount: totalClinics },
    stateLocation: stateLoc ? mapLocation(stateLoc, stateCode) : null,
    services: servicesRes.docs.map((t: any) => mapService(t)),
    brands: (brandsRes.docs as any[]).map((b: any) => ({ id: String(b.id), name: b.name, slug: b.slug })),
    clinics,
    neighborhoods: hoodsRes.docs.map((h: any) => ({
      id: String(h.id), name: h.name, slug: h.slug, providerCount: h.providerCount ?? 0,
    })),
    faqs: faqBlock.faqs,
    faqSeeAll: faqBlock.seeAll,
    totalClinics,
    allClinicLinks,
  }
})

// ─── generateStaticParams helpers ────────────────────────────────────────────

export async function getAllServiceSlugs(): Promise<string[]> {
  const payload = await getPayloadInstance()
  const res = await payload.find({ collection: 'services', limit: 500, depth: 0 })
  return res.docs.map((t: any) => t.slug)
}

// ─── Services index — /services ──────────────────────────────────────────────

export type ServiceIndexEntry = {
  id: string
  name: string
  slug: string
  tagline?: string
  category: string
  clinicCount: number
}

export const getServicesIndex = cache(async function getServicesIndex(): Promise<ServiceIndexEntry[]> {
  const payload = await getPayloadInstance()

  const [res, pool] = await Promise.all([
    payload.find({ collection: 'services', limit: 500, depth: 0, sort: 'name' }),
    Promise.resolve((payload.db as any).pool),
  ])

  const counts = new Map<string, number>()
  try {
    const r = await pool.query(
      `SELECT cr.services_id AS sid, count(*)::int AS n
         FROM clinics c
         JOIN clinics_rels cr ON cr.parent_id = c.id AND cr.services_id IS NOT NULL
        WHERE c.status = 'published'
        GROUP BY cr.services_id`,
    )
    for (const row of r.rows) counts.set(String(row.sid), Number(row.n))
  } catch { /* counts stay 0 */ }

  return (res.docs as any[]).map((t) => ({
    id: String(t.id),
    name: t.name,
    slug: t.slug,
    tagline: t.tagline ?? undefined,
    category: t.category ?? '',
    clinicCount: counts.get(String(t.id)) ?? 0,
  }))
})


export async function getAllStateSlugs(): Promise<string[]> {
  const payload = await getPayloadInstance()
  const res = await payload.find({
    collection: 'locations',
    where: { and: [{ kind: { equals: 'state' } }, { isLive: { equals: true } }, { noindex: { not_equals: true } }] },
    limit: 500, depth: 0,
  })
  return res.docs.map((l: any) => l.slug)
}

export async function getAllCitySlugs(): Promise<string[]> {
  const payload = await getPayloadInstance()
  const res = await payload.find({
    collection: 'locations',
    where: { and: [{ kind: { in: ['metro', 'city'] } }, { isLive: { equals: true } }, { noindex: { not_equals: true } }] },
    limit: 500, depth: 0,
  })
  return res.docs.map((l: any) => l.slug)
}

// Returns { stateSlug, citySlug } pairs for all live indexable cities
export async function getAllStateCityPairs(): Promise<Array<{ stateSlug: string; citySlug: string }>> {
  const payload = await getPayloadInstance()
  const [slugMap, citiesRes] = await Promise.all([
    getLocationSlugMap(),
    payload.find({
      collection: 'locations',
      where: { and: [{ kind: { in: ['metro', 'city'] } }, { isLive: { equals: true } }, { noindex: { not_equals: true } }] },
      limit: 500, depth: 0,
    }),
  ])
  return (citiesRes.docs as any[])
    .map((c: any) => {
      const entry = slugMap.get(
        `${(c.name as string).replace(/\s+city$/i, '').trim().toLowerCase()},${(c.state ?? '').toLowerCase()}`,
      )
      return entry ? { citySlug: c.slug, stateSlug: entry.stateSlug } : null
    })
    .filter(Boolean) as Array<{ stateSlug: string; citySlug: string }>
}

// ─── State/City filter bar (real clinic counts) ─────────────────────────────
// Shared by the /clinics state+city dropdown (ClinicsGrid.tsx) and the /search
// page's location bar (shown only when no location text is present). Only
// states/cities with at least one published clinic are returned.

export type StateFilterOption = { code: string; name: string; slug: string; clinicCount: number }

/**
 * `cache()` dedupes within one request; `ttlMemo` dedupes ACROSS requests, which
 * is what this needed. Every /search render re-ran the per-state clinic rollup
 * over all published clinics, and the answer is identical for every visitor
 * until a clinic is published. See lib/ttl-memo.ts; bypass with
 * SEARCH_OPTION_CACHE=0.
 */
export const getLocationFilterOptions = cache(ttlMemo(async function getLocationFilterOptions(): Promise<StateFilterOption[]> {
  const payload = await getPayloadInstance()
  const pool = (payload.db as any).pool

  const [statesRes, countsRes] = await Promise.all([
    payload.find({ collection: 'locations', where: { kind: { equals: 'state' } }, limit: 60, depth: 0 }),
    pool.query(
      `SELECT upper(state) AS code, count(*)::int AS n
         FROM clinics
        WHERE status = 'published' AND state IS NOT NULL AND state <> ''
        GROUP BY upper(state)`,
    ),
  ])

  const countByCode = new Map<string, number>()
  for (const row of countsRes.rows as any[]) countByCode.set(String(row.code).toUpperCase(), Number(row.n))

  return (statesRes.docs as any[])
    .map((s) => {
      const code = String(s.state ?? '').toUpperCase()
      return { code, name: String(s.name), slug: String(s.slug), clinicCount: countByCode.get(code) ?? 0 }
    })
    .filter((s) => s.code && s.clinicCount > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
}))

/** Real per-city clinic counts for one state -- same query shape as getStateHub's
 * city list, exposed standalone so /clinics and /search can both call it without
 * going through the full state-hub page loader. */
export async function getCityFilterOptions(stateCode: string): Promise<StateCityEntry[]> {
  const payload = await getPayloadInstance()
  const pool = (payload.db as any).pool

  const [slugMap, citiesRes] = await Promise.all([
    getLocationSlugMap(),
    pool.query(
      `SELECT MIN(city) AS city, count(*)::int AS n
         FROM clinics
        WHERE status = 'published'
          AND upper(state) = upper($1)
          AND city IS NOT NULL AND city <> ''
        GROUP BY lower(city)
        ORDER BY count(*) DESC`,
      [stateCode],
    ),
  ])

  return (citiesRes.rows as any[])
    .map((row) => {
      const slugs = lookupSlugs(row.city ?? '', stateCode, slugMap)
      return { name: String(row.city), slug: slugs.citySlug, clinicCount: Number(row.n ?? 0) }
    })
    .filter((c) => c.clinicCount > 0)
}
