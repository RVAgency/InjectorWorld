import { getPayloadInstance } from './payload-server'
import { getLocationSlugMap, lookupSlugs } from './location-slug-lookup'

export type ClinicHours = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', string>>

export type ClinicTreatment = {
  id: number
  name: string
  slug: string
}

export type ClinicFaq = {
  id: string
  question: string
  answer: string
  detail?: string
  offLabel?: boolean
  safetyFlag?: string
  relatedGuideSlug?: string
  relatedGuideTitle?: string
}

export type ClinicReview = {
  id: string
  rating: number
  title?: string
  excerpt?: string
  text?: string
  publishStatus: 'full' | 'excerpt_only' | 'hidden'
  serviceTag?: string
  reviewDate?: string
  sourcePlatform?: string
  sourceUrl?: string
  attributionRequired: boolean
  responseFromProvider?: string
  responseDate?: string
}

export type ClinicListItem = {
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
  startingPrice?: number
  photoUrl?: string
  phone?: string
  latitude: number
  longitude: number
  clinicType?: string
  brandsOffered?: string[]
  servicesOffered?: string[]
  providerCount: number
  /**
   * Miles from the visitor, set only when the listing was ordered around an
   * IP-located point and this clinic fell inside the near cutoff. Undefined
   * means "unknown", never "zero".
   */
  distanceMiles?: number
  /** In the visitor's own ZIP on a near-me listing (2026-09-28). */
  inZip?: boolean
}

export type ClinicDetail = Omit<ClinicListItem, 'brandsOffered' | 'servicesOffered'> & {
  clinicId: string
  description?: string
  addressLine1: string
  addressLine2?: string
  county?: string
  zip: string
  latitude: number
  longitude: number
  googleMapsUrl?: string
  directionsUrl?: string
  email?: string
  websiteUrl: string
  bookingUrl?: string
  logoUrl?: string
  photoUrls: string[]
  hoursJson?: ClinicHours
  acceptsInsurance: boolean
  paymentMethods?: string
  amenities?: string
  servicesOffered: ClinicTreatment[]
  brandsOffered: ClinicTreatment[]
  claimed: boolean
  reviews: ClinicReview[]
  relatedClinics: ClinicRelated[]
  status?: string
  publishedAt?: string
  instagramUrl?: string
  tiktokUrl?: string
  facebookUrl?: string
  linkedinUrl?: string
  youtubeUrl?: string
  /** Owner opt-in. A scraped email stays private until a claimed clinic turns this on. */
  emailPublic?: boolean
  /** Payload-maintained. Drives the "Updated" line in the profile hero. */
  updatedAt?: string
}

export type ClinicRelated = {
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
  servicesOffered?: string[]
  startingPrice?: number
}



function photoFromMedia(media: any): string | undefined {
  if (!media || typeof media !== 'object') return undefined
  return (
    media.sizes?.hero?.url ||
    media.sizes?.card?.url ||
    media.url ||
    undefined
  )
}

function clinicPhotoUrls(c: any): string[] {
  const uploaded = Array.isArray(c.photos)
    ? c.photos.map(photoFromMedia).filter(Boolean)
    : []
  const legacy = Array.isArray(c.clinicPhotoUrls)
    ? c.clinicPhotoUrls.map((p: any) => p?.url).filter(Boolean)
    : []
  return Array.from(new Set([...uploaded, ...legacy]))
}

function normalizeHours(hours: unknown): ClinicHours | undefined {
  if (!hours) return undefined
  const parsed =
    typeof hours === 'string'
      ? (() => {
          try {
            return JSON.parse(hours)
          } catch {
            return null
          }
        })()
      : hours

  if (!parsed || typeof parsed !== 'object') return undefined

  const aliases: Record<string, keyof ClinicHours> = {
    mon: 'mon',
    monday: 'mon',
    tue: 'tue',
    tues: 'tue',
    tuesday: 'tue',
    wed: 'wed',
    wednesday: 'wed',
    thu: 'thu',
    thur: 'thu',
    thurs: 'thu',
    thursday: 'thu',
    fri: 'fri',
    friday: 'fri',
    sat: 'sat',
    saturday: 'sat',
    sun: 'sun',
    sunday: 'sun',
  }

  const out: ClinicHours = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const day = aliases[key.toLowerCase()]
    if (!day) continue
    if (typeof value === 'string' && value.trim()) out[day] = value.trim()
    if (value && typeof value === 'object') {
      const objectValue = value as Record<string, unknown>
      const open = typeof objectValue.open === 'string' ? objectValue.open : ''
      const close = typeof objectValue.close === 'string' ? objectValue.close : ''
      const closed = objectValue.closed === true
      if (closed) out[day] = 'Closed'
      else if (open && close) out[day] = `${open}-${close}`
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function mapTreatments(treatments: unknown): ClinicTreatment[] {
  if (!Array.isArray(treatments)) return []
  return treatments
    .filter((t: any) => t && typeof t === 'object' && t.name && t.slug)
    .map((t: any) => ({ id: Number(t.id), name: t.name, slug: t.slug }))
    .filter((t) => Number.isFinite(t.id))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function mapRelatedClinic(c: any, slugMap: Awaited<ReturnType<typeof getLocationSlugMap>>, providerCount = 0): ClinicRelated {
  const slugs = lookupSlugs(c.city ?? '', c.state ?? '', slugMap)
  const photos = clinicPhotoUrls(c)
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
    photoUrl: photos[0],
    latitude: Number(c.latitude) || 0,
    longitude: Number(c.longitude) || 0,
    providerCount,
    clinicType: c.clinicType ?? undefined,
    servicesOffered: Array.isArray(c.servicesOffered)
      ? c.servicesOffered.map((t: any) => (typeof t === 'object' ? t.name : '')).filter(Boolean)
      : undefined,
    startingPrice: c.startingPrice ?? undefined,
  }
}

function mapClinicReview(review: any): ClinicReview {
  const publishStatus = ['full', 'excerpt_only', 'hidden'].includes(review.publishStatus)
    ? review.publishStatus
    : 'excerpt_only'

  return {
    id: String(review.id),
    rating: Number(review.rating) || 0,
    title: review.title ?? undefined,
    excerpt: review.excerpt ?? undefined,
    text: review.text ?? undefined,
    publishStatus,
    serviceTag: review.serviceTag ?? undefined,
    reviewDate: review.reviewDate ?? undefined,
    sourcePlatform: review.sourcePlatform ?? undefined,
    sourceUrl: review.sourceUrl ?? undefined,
    attributionRequired: !!review.attributionRequired,
    responseFromProvider: review.responseFromProvider ?? undefined,
    responseDate: review.responseDate ?? undefined,
  }
}

// getClinicTypeFaqs lived here until 2026-09-13. It put the same generic
// clinic-type FAQs on every clinic profile (57k near-identical blocks), and no
// such FAQ existed anyway. Clinic pages now build their own clinic-specific FAQs
// (buildFallbackFaqs in the page). See docs/FAQ-SYSTEM-2026-09-13.md.

export type ClinicsStats = {
  total: number
  stateCount: number
  avgRating: string
}

/**
 * Throws on failure (2026-09-22). It used to catch and return zeros, and its
 * only caller, the /clinics page, could not tell that from a real answer: the
 * hero said 24 clinics, the grid said "Showing 24 of 24" and Load more
 * disappeared. A failed read must reach the page so ISR keeps serving the last
 * good render. See docs/LISTING-FIX-PLAN-2026-09-19.md TASK 6.
 */
export async function getClinicsStats(): Promise<ClinicsStats> {
  const payload = await getPayloadInstance()
  const pool = (payload.db as any).pool
  const res = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(DISTINCT state)::int AS state_count,
      ROUND(AVG(aggregate_rating)::numeric, 1) AS avg_rating
    FROM clinics
    WHERE status = 'published'
  `)
  const row = res.rows[0]
  return {
    total: Number(row.total) || 0,
    stateCount: Number(row.state_count) || 0,
    avgRating: row.avg_rating ? String(row.avg_rating) : '0.0',
  }
}

export async function getClinicsListing(limit = 500): Promise<ClinicListItem[]> {
  const payload = await getPayloadInstance()
  const [slugMap, res] = await Promise.all([
    getLocationSlugMap(),
    payload.find({
      collection: 'clinics',
      where: { status: { equals: 'published' } },
      limit,
      depth: 1,
      sort: '-aggregateRatingCount',
    }),
  ])
  return res.docs.map((c: any) => {
    const s = lookupSlugs(c.city ?? '', c.state ?? '', slugMap)
    const photos = clinicPhotoUrls(c)
    return {
      id: String(c.id),
      slug: c.slug,
      citySlug: s.citySlug,
      stateSlug: s.stateSlug,
      clinicName: c.clinicName,
      tagline: c.tagline,
      city: c.city,
      state: c.state,
      neighborhood: c.neighborhood,
      aggregateRating: c.aggregateRating,
      aggregateRatingCount: c.aggregateRatingCount,
      startingPrice: c.startingPrice ?? undefined,
      photoUrl: photos[0],
      phone: c.phone,
      latitude: Number(c.latitude) || 0,
      longitude: Number(c.longitude) || 0,
      clinicType: c.clinicType ?? undefined,
      brandsOffered: Array.isArray(c.brandsOffered)
        ? c.brandsOffered.map((b: any) => String(typeof b === 'object' ? b.id : b)).filter(Boolean)
        : [],
      servicesOffered: Array.isArray(c.servicesOffered)
        ? c.servicesOffered.map((s: any) => String(typeof s === 'object' ? s.id : s)).filter(Boolean)
        : [],
      // Providers aren't live yet; DirectoryClinicCard hides this row at 0.
      providerCount: 0,
    }
  })
}

export async function getClinicBySlug(slug: string): Promise<ClinicDetail | null> {
  try {
    return await getClinicBySlugUnsafe(slug)
  } catch (err) {
    console.error(`[getClinicBySlug] failed for slug "${slug}":`, err)
    return null
  }
}

async function getClinicBySlugUnsafe(slug: string): Promise<ClinicDetail | null> {
  const payload = await getPayloadInstance()
  const [slugMap, res] = await Promise.all([
    getLocationSlugMap(),
    payload.find({
      collection: 'clinics',
      where: {
        and: [
          { slug: { equals: slug } },
          { status: { equals: 'published' } },
        ],
      } as any,
      limit: 1,
      depth: 2,
    }),
  ])
  const c = res.docs[0]
  if (!c) return null

  const clinicSlugs = lookupSlugs(c.city ?? '', c.state ?? '', slugMap)

  const [relatedRes, reviewsRes] = await Promise.all([
    payload.find({
      collection: 'clinics',
      where: {
        and: [
          { city: { like: c.city ?? '' } },
          { state: { equals: c.state ?? '' } },
          { status: { equals: 'published' } },
          { id: { not_equals: c.id } },
        ],
      } as any,
      limit: 3,
      depth: 1,
      sort: '-aggregateRatingCount',
    }),
    payload.find({
      collection: 'reviews',
      where: {
        and: [
          { clinic: { equals: c.id } },
          { moderationStatus: { equals: 'approved' } },
        ],
      } as any,
      limit: 20,
      depth: 0,
      sort: '-reviewDate',
    }),
  ])

  const photos = clinicPhotoUrls(c)

  return {
    id: String(c.id),
    clinicId: c.clinicId,
    slug: c.slug,
    citySlug: clinicSlugs.citySlug,
    stateSlug: clinicSlugs.stateSlug,
    clinicName: c.clinicName,
    tagline: c.tagline ?? undefined,
    description: c.description ?? undefined,
    addressLine1: c.addressLine1 ?? '',
    addressLine2: c.addressLine2 ?? undefined,
    county: c.county ?? undefined,
    city: c.city,
    state: c.state,
    zip: c.zip ?? '',
    neighborhood: c.neighborhood ?? undefined,
    latitude: Number(c.latitude) || 0,
    longitude: Number(c.longitude) || 0,
    googleMapsUrl: c.googleMapsUrl ?? undefined,
    directionsUrl: c.directionsUrl ?? c.googleMapsUrl ?? undefined,
    phone: c.phone ?? undefined,
    email: c.email ?? undefined,
    websiteUrl: c.websiteUrl ?? '',
    bookingUrl: c.bookingUrl ?? undefined,
    logoUrl: c.logoUrl ?? undefined,
    photoUrls: photos,
    hoursJson: normalizeHours(c.hoursJson),
    acceptsInsurance: !!c.acceptsInsurance,
    paymentMethods: c.paymentMethods ?? undefined,
    amenities: c.amenities ?? undefined,
    servicesOffered: mapTreatments(c.servicesOffered),
    brandsOffered: mapTreatments(c.brandsOffered),
    aggregateRating: c.aggregateRating ?? undefined,
    aggregateRatingCount: c.aggregateRatingCount ?? undefined,
    startingPrice: c.startingPrice ?? undefined,
    // Providers aren't live yet; DirectoryClinicCard hides this row at 0.
    providerCount: 0,
    photoUrl: photos[0],
    claimed: !!c.claimed,
    reviews: reviewsRes.docs.map(mapClinicReview),
    relatedClinics: relatedRes.docs.map((clinic: any) =>
      mapRelatedClinic(clinic, slugMap),
    ),
    status: c.status ?? undefined,
    publishedAt: c.publishedAt ?? undefined,
    clinicType: c.clinicType ?? undefined,
    instagramUrl: c.instagramUrl ?? undefined,
    tiktokUrl: c.tiktokUrl ?? undefined,
    facebookUrl: c.facebookUrl ?? undefined,
    linkedinUrl: c.linkedinUrl ?? undefined,
    youtubeUrl: c.youtubeUrl ?? undefined,
    emailPublic: !!c.emailPublic,
    updatedAt: c.updatedAt ?? undefined,
  }
}


/**
 * Hard cap on how many clinic pages the build will pre-render.
 *
 * Today the `noindex = false` filter narrows ~29k clinics down to a few
 * hundred, so this limit is not reached. That is a coincidence of current
 * data, not a design guarantee: flipping clinics to indexable would hand
 * `generateStaticParams` tens of thousands of rows, and with
 * `experimental.cpus: 1` (set in next.config.mjs to avoid exhausting the DB
 * connection limit during build) those render on a single worker. The build
 * would go from minutes to hours, or exceed the 4GB heap it is given.
 *
 * Uncapped pre-rendering is not needed anyway: pages beyond this limit are
 * still generated on first request via ISR and cached from then on. The only
 * thing pre-rendering buys is a fast FIRST hit, which matters for the pages
 * that actually get traffic. So we order by review volume and take the top N.
 *
 * Raise PRERENDER_CLINIC_LIMIT deliberately, after checking build duration.
 */
const PRERENDER_CLINIC_LIMIT = Math.max(
  0,
  parseInt(process.env.PRERENDER_CLINIC_LIMIT || '2000', 10) || 2000,
)

export async function getAllClinicParams(): Promise<{ state: string; city: string; slug: string }[]> {
  const payload = await getPayloadInstance()
  const pool = (payload.db as any).pool
  const [slugMap, res] = await Promise.all([
    getLocationSlugMap(),
    pool.query(
      `SELECT slug, city, state
         FROM clinics
        WHERE status = 'published'
          AND COALESCE(noindex, true) = false
          AND slug IS NOT NULL AND slug <> ''
          AND city IS NOT NULL AND city <> ''
          AND state IS NOT NULL AND state <> ''
        ORDER BY aggregate_rating_count DESC NULLS LAST, id ASC
        LIMIT $1`,
      [PRERENDER_CLINIC_LIMIT],
    ),
  ])
  const isValidPathSegment = (s: string) =>
    s.length > 0 && s.length <= 200 && /^[a-z0-9][a-z0-9-]*$/.test(s)
  return res.rows
    .map((c: any) => {
      const s = lookupSlugs(c.city ?? '', c.state ?? '', slugMap)
      return { state: s.stateSlug, city: s.citySlug, slug: c.slug }
    })
    .filter((p: { state: string; city: string; slug: string }) =>
      isValidPathSegment(p.state) && isValidPathSegment(p.city) && isValidPathSegment(p.slug),
    )
}
