import { getPayloadInstance } from './payload-server'
import { getLocationSlugMap, lookupSlugs } from './location-slug-lookup'
import { rankClinics } from './ranking'
import { lookupZip } from './zip-lookup'
import { geocode } from './geocode'
import type { DirectoryClinic } from './location-queries'
import {

  clinicTsv,
  clinicGeog,
  clinicDistanceMeters,
  clinicDistanceMetersHaversine,
  clinicBoundingBoxSql,
  toPrefixTsQuery,
  METERS_PER_MILE,
} from './search-sql'
import {
  parseSearchQuery,
  buildServiceLookup,
  buildBrandLookup,
  buildTolerantLookups,
  resolveTolerant,
  type IntentLookups,
  type ParsedIntent,
} from './search-intent'
import { leanHydrateClinics, leanHydrationEnabled } from './search-hydrate'
import { blendedScoreSql, rankedSqlEnabled } from './search-ranking-sql'
import { ttlMemo } from './ttl-memo'
import { parseLeanListingFilters, type LeanListingFilters } from './lean-clinic-listing'
import { NEAR_ME_RADIUS_LADDER, NEAR_ME_ZIP_REACH_MILES } from './merit'

// ── PostGIS availability cache ────────────────────────────────────────────────
// Some DB instances (DigitalOcean Managed Postgres out-of-box) do not have
// PostGIS installed — confirmed it is not even installable on the production
// cluster (not in pg_available_extensions). We check once per server process
// and cache the result so every request after the first is free. When PostGIS
// is absent, providerCandidates/clinicCandidates fall back to the plain-SQL
// Haversine expression (clinicDistanceMetersHaversine in search-sql.ts) for
// both the radius WHERE clause and the distance-for-ranking value, so geo
// search still works, just without a GIST index. Installing PostGIS on the DB
// switches back to ST_DWithin/ST_Distance automatically with no code change.
let _postgisAvailable: boolean | null = null
async function isPostGisAvailable(pool: any): Promise<boolean> {
  if (_postgisAvailable !== null) return _postgisAvailable
  try {
    // pg_proc contains one row per function; st_dwithin exists only when PostGIS
    // is installed. This never throws — a missing extension just returns 0 rows.
    const res = await pool.query(
      `SELECT 1 FROM pg_proc WHERE proname = 'st_dwithin' LIMIT 1`,
    )
    _postgisAvailable = res.rows.length > 0
  } catch {
    _postgisAvailable = false
  }
  if (!_postgisAvailable) {
    console.warn('[search] PostGIS not available — geo radius search disabled. Install PostGIS to enable.')
  }
  return _postgisAvailable
}

// ─────────────────────────────────────────────────────────────────────────────
// Server-side search (Phase 5, omnibox upgrade in Phase 13).
//
// Phase 13 turns the two-field (treatment + location) search into a true omnibox:
// a single free-text `q` is parsed (lib/search-intent.ts) into treatment +
// location + zip + leftover name text, and each part is applied as the matching
// SQL filter. Relevance uses ts_rank over the weighted tsvectors, blended with
// merit (+ distance when geocoded).
//
// The heavy filtering runs in Postgres using the indexes from
// `scripts/setup-search-indexes.ts`:
//   - free-text  -> GIN full-text on provider/clinic names (prefix tsquery) PLUS
//                   the isolated search.provider_doc (treatments/specialties/langs)
//   - treatment  -> relational EXISTS on providers_rels
//   - location   -> state/city/neighborhood text
//   - zip / geo  -> PostGIS ST_DWithin radius (geocoded centroid)
//
// SQL returns only matching IDs (+ distance + text_rank); we hydrate those rows
// via Payload (to reuse field mapping + merit), rank, and paginate.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_RADIUS_MILES = 25
/**
 * Wider radius for the place-name fallback (a typed city we have no exact data
 * for, e.g. "newport beach"): surface the nearest metro within a generous reach
 * rather than returning nothing.
 */
const FALLBACK_RADIUS_MILES = 60
/**
 * State names a visitor types meaning the METRO, not the state.
 *
 * "new york" is both a state name and a city name, and the resolver checks state
 * names first, so typing it returned all 3,163 clinics in New York State ranked
 * by merit. The top of that list was Poughkeepsie, Fishkill and East Amherst,
 * because those clinics carry the most reviews. Someone typing "new york" is
 * looking for New York City.
 *
 * Resolved as a RADIUS, not as `city = 'New York'`. The city column holds
 * Manhattan addresses as "New York" and the other boroughs under their own names,
 * so a city match returns 364 clinics and silently drops Brooklyn, Queens and
 * Staten Island. Measured on staging 2026-09-05, 25 miles from Manhattan:
 *
 *   1,946 clinics: New York 364, Brooklyn 92, Garden City 52, Paramus 43,
 *   Englewood 39, Staten Island 35, ... (1,075 NY + 871 NJ)
 *
 * against 364 for the city match and 3,163 for the whole state. Distance is part
 * of the ranking, so Manhattan leads and the New Jersey side of the metro sits
 * further down rather than being excluded.
 *
 * DELIBERATELY ONLY NEW YORK. Six state names are also city names in the clinic
 * data, and for the other five the state reading is the right one: someone
 * typing "Wyoming" wants the state (151 clinics), not the town in Michigan (18).
 * Same for Oregon (713 vs 7), Indiana (936 vs 2) and Delaware (107 vs 8).
 * "Washington" is genuinely ambiguous (state, or DC, which is not in the state at
 * all) and is left alone until that is decided on purpose.
 *
 * Only the TYPED text is affected. Picking New York from the state dropdown sends
 * `state=NY`, which resolves through stateByCode and still means the state.
 */
const STATE_NAME_METRO_OVERRIDES: Record<
  string,
  { lat: number; lng: number; radiusMiles: number; label: string }
> = (() => {
  const nyc = { lat: 40.7128, lng: -74.006, radiusMiles: 25, label: 'New York City' }
  // All three spellings resolve to the same metro. The aliases matter because
  // the parser consumes the LONGEST known location phrase: without "new york
  // city" in the phrase list it matched only "new york" and left "city" behind
  // as a name query, so `q="new york city"` returned 89 clinics whose names
  // happen to contain the word "city" instead of the metro's 1,946.
  return { 'new york': nyc, 'new york city': nyc, nyc }
})()

/** Hard safety cap on candidate rows pulled from SQL before ranking. */
const CANDIDATE_CAP = 3000
/**
 * Extra rows fetched beyond the requested page when SEARCH_RANKED_SQL orders in
 * SQL. Absorbs any float difference between the Postgres and JS versions of the
 * blended score, so a disagreement can only ever affect rows past the margin.
 *
 * 25, not the 100 this shipped with. The /search page asks for limit=100, so a
 * margin of 100 meant hydrating 200 rows to render 100 — double the work for a
 * guard against float ties that, measured across the 16-query baseline, never
 * moved a single row. 25 is still a full page of slack past the last visible
 * result.
 */
const RANKED_FETCH_MARGIN = 25

/**
 * How deep /search can page. Every page is sliced out of at most CANDIDATE_CAP
 * ranked candidates, so nothing past this many results is reachable; the page
 * says "refine your search" beyond it rather than offering a Load more that
 * would come back empty.
 */
export const SEARCH_RESULT_CAP = CANDIDATE_CAP

/** Rows per /search page: page 1 is server-rendered, the rest come from /api/search/more. */
export const SEARCH_PAGE_SIZE = 100

/**
 * The listing-panel filters (brand, service, clinic type, rating, distance),
 * resolved in SQL the same way every other clinic listing resolves them
 * (2026-09-28). Until then /search filtered in the browser over the 100 rows it
 * had loaded, so a brand filter only searched those 100, the totals were wrong,
 * and "Clinic type" always returned nothing because search rows carry no
 * clinicType.
 *
 * `near` is deliberately absent: it is a SORT origin on the other listings, and
 * search has its own ranking, which these filters must never change.
 */
export type SearchListingFilters = Omit<LeanListingFilters, 'near'>

/** True when at least one listing filter would narrow the result set. */
export function hasSearchListingFilters(f: SearchListingFilters | undefined): boolean {
  if (!f) return false
  return Boolean(
    f.brandIds?.length ||
      f.serviceIds?.length ||
      f.clinicTypes?.length ||
      f.minRating != null ||
      (f.radiusMiles != null && f.lat != null && f.lng != null),
  )
}

/**
 * Defensive copy of the filters, so searchDirectory never depends on its caller
 * having validated them. Ids, types and rating are bound parameters, but a
 * non-integer id would still make the `::int[]` cast throw. lat, lng and radius
 * are interpolated into SQL as numeric literals (the search-sql.ts contract),
 * so they must be finite numbers in range or the distance filter is dropped.
 */
function sanitizeListingFilters(f: SearchListingFilters | undefined): SearchListingFilters {
  if (!f) return {}
  const ids = (v: number[] | undefined) => {
    const out = (v ?? []).filter((n) => Number.isInteger(n) && n > 0)
    return out.length ? out : undefined
  }
  const types = (f.clinicTypes ?? []).filter((t) => typeof t === 'string' && t.length > 0)
  const rating = typeof f.minRating === 'number' && Number.isFinite(f.minRating) && f.minRating > 0
    ? f.minRating
    : undefined
  const geoOk =
    typeof f.radiusMiles === 'number' && Number.isFinite(f.radiusMiles) && f.radiusMiles > 0 &&
    typeof f.lat === 'number' && Number.isFinite(f.lat) && f.lat >= -90 && f.lat <= 90 &&
    typeof f.lng === 'number' && Number.isFinite(f.lng) && f.lng >= -180 && f.lng <= 180
  return {
    brandIds: ids(f.brandIds),
    serviceIds: ids(f.serviceIds),
    clinicTypes: types.length ? types : undefined,
    minRating: rating,
    ...(geoOk ? { radiusMiles: f.radiusMiles, lat: f.lat, lng: f.lng } : {}),
  }
}

/**
 * Everything the /search page reads from its url, in one place, so the page
 * and /api/search/more (its Load more) build the search from exactly the same
 * inputs. If they ever drifted, page 2 would be a page of a different search.
 */
export type SearchPageRequest = {
  q: string
  treatment: string
  location: string
  barState: string
  barCity: string
  /** What actually gets searched as the location. */
  effectiveLocation: string
  /** The omnibox prefill. */
  omniValue: string
  hasQuery: boolean
  filters: SearchListingFilters
  filtersActive: boolean
}

export function readSearchPageRequest(sp: URLSearchParams): SearchPageRequest {
  const get = (key: string) => (sp.get(key) ?? '').trim()
  const q = get('q')
  // Backward-compatible: older links still use treatment/location params.
  const treatment = get('treatment')
  // `location` is what the USER typed (omnibox/hero). `state`/`city` come from
  // the LocationFilterBar dropdown -- kept as separate params so selecting a
  // state doesn't look like "the user typed a location" and hide the bar that
  // just set it (that self-defeating loop was the bug: picking a state made
  // the bar disappear because the code only checked one shared `location`).
  const location = get('location')
  const barState = get('state')
  const barCity = get('city')
  // What actually gets searched: typed location wins, else city (matches by
  // name), else bare state code (searchDirectory already resolves 2-letter
  // codes) -- both existing paths in searchDirectory, no backend change.
  const effectiveLocation = location || barCity || barState
  // The omnibox prefill is the free-text q, or the legacy fields joined.
  const omniValue = q || [treatment, location].filter(Boolean).join(' ')
  const hasQuery = !!(q || treatment || location || barState || barCity)

  // The same parser every other listing route uses for these params, so a
  // filter url means the same thing here as there. `near` is left out on
  // purpose: see SearchListingFilters.
  const parsed = parseLeanListingFilters(sp)
  const filters: SearchListingFilters = {
    brandIds: parsed.brandIds,
    serviceIds: parsed.serviceIds,
    clinicTypes: parsed.clinicTypes,
    minRating: parsed.minRating,
    radiusMiles: parsed.radiusMiles,
    lat: parsed.lat,
    lng: parsed.lng,
  }

  return {
    q,
    treatment,
    location,
    barState,
    barCity,
    effectiveLocation,
    omniValue,
    hasQuery,
    filters,
    filtersActive: hasSearchListingFilters(filters),
  }
}

/**
 * One page of /search results. Page 1 is the server render, later pages are
 * Load more. `visitorLocation` answers "near me" queries; both callers pass one
 * built from the same request, so page 2 is centred where page 1 was.
 */
export function searchPageResults(
  req: SearchPageRequest,
  page = 1,
  visitorLocation?: SearchParams['visitorLocation'],
): Promise<SearchResult> {
  return searchDirectory({
    q: req.q,
    treatment: req.treatment,
    location: req.effectiveLocation,
    limit: SEARCH_PAGE_SIZE,
    page,
    // allowGeocode turns a ZIP / place name into a radius search.
    allowGeocode: true,
    filters: req.filters,
    visitorLocation,
  })
}

export type SearchClinic = DirectoryClinic & { distanceMiles?: number; textRank?: number }

export type SearchParams = {
  /** Free-text omnibox query (treatment / location / zip / name / phrase). */
  q?: string
  /** Explicit treatment slug or name (overrides what the parser finds in q). */
  treatment?: string
  /** Explicit location text (overrides the parser). Ignored when lat/lng set. */
  location?: string
  /** Geocoded coordinates. When present, radius search is used. */
  lat?: number
  lng?: number
  /** Search radius in miles (default 25). Only used with lat/lng. */
  radiusMiles?: number
  /** 1-based page. */
  page?: number
  /** Page size (per entity). */
  limit?: number
  /**
   * Allow server-side geocoding (ZIP -> coords, and a place-name fallback when a
   * name search is empty). OFF by default so the as-you-type Hero panel stays fast
   * and never geocodes a half-typed word; the /search page + the API geo=1 path
   * turn it on.
   */
  allowGeocode?: boolean
  /**
   * Listing-panel filters, applied in SQL on top of whatever the query resolved
   * to. They only ever narrow the match set: the ranking, and the result of a
   * search with no filters, are unchanged. See SearchListingFilters.
   */
  filters?: SearchListingFilters
  /**
   * Where the visitor is, for a "near me" query that names no place: the
   * centre of their ZIP and its label. Called lazily, only for such a query.
   * Leave it out on any response that is cached for everyone (/api/search),
   * or one visitor's location would be served to the next.
   */
  visitorLocation?: () => Promise<{ lat: number; lng: number; label: string; zip?: string } | null>
  /**
   * Internal: parse the query with exact dictionary matching only, which is
   * how search behaved before spelling tolerance (2026-09-28). searchDirectory
   * sets it itself when a tolerant reading finds nothing.
   */
  exactParse?: boolean
}

export type SearchResult = {
  clinics: SearchClinic[]
  serviceLabel?: string
  brandLabel?: string
  locationLabel?: string
  clinicTotal: number
  page: number
  limit: number
  /** The point the search was centered on, when a location resolved to coords. */
  center?: { lat: number; lng: number } | null
  /**
   * Set when the search was centred on a ZIP with the default radius
   * (2026-09-28): the ZIP, how many results are in it (they lead the list),
   * and the radius the list reaches. The page words the "no clinics in this
   * ZIP" note from it.
   */
  zipNotice?: { zip: string; zipCount: number; radiusMiles: number }
}

/**
 * Radii a ZIP-centred search tries in order (2026-09-28), the same ladder the
 * near-me listings use: the ZIP's own clinics first, then the rest within 3
 * miles, widening only when a rung has nothing. Was a flat 25 miles.
 */
const ZIP_SEARCH_RADIUS_LADDER = NEAR_ME_RADIUS_LADDER

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function mapClinic(c: any, slugMap: Map<string, { citySlug: string; stateSlug: string }>, providerCount: number, distanceMiles?: number, textRank?: number): SearchClinic {
  const { citySlug, stateSlug } = lookupSlugs(c.city ?? '', c.state ?? '', slugMap)
  return {
    id: String(c.id),
    slug: c.slug,
    citySlug,
    stateSlug,
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
    providerCount,
    brandsOffered: Array.isArray(c.brandsOffered)
      ? c.brandsOffered.map((b: any) => String(typeof b === 'object' ? b.id : b)).filter(Boolean)
      : [],
    servicesOffered: Array.isArray(c.servicesOffered)
      ? c.servicesOffered.map((s: any) => String(typeof s === 'object' ? s.id : s)).filter(Boolean)
      : [],
    distanceMiles,
    textRank,
  }
}

/** Five digits, or nothing: a ZIP is interpolated into SQL as a literal. */
function safeZip(z: string | undefined | null): string | undefined {
  return typeof z === 'string' && /^\d{5}$/.test(z) ? z : undefined
}

/**
 * A small WHERE-clause builder that tracks positional ($1, $2, …) parameters so
 * user-supplied text is always parameterized (never string-interpolated).
 */
class Where {
  clauses: string[] = []
  params: any[] = []
  add(sql: string) {
    this.clauses.push(sql)
  }
  /** Add a clause and bind a parameter; returns the $n placeholder. */
  bind(value: any): string {
    this.params.push(value)
    return `$${this.params.length}`
  }
  sql(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : ''
  }
}

// ── Cached intent + resolution lookups (rebuilt every few minutes) ───────────
type SearchLookups = {
  intent: IntentLookups
  slugToTreatment: Map<string, { id: number; name: string }>
  slugToBrand: Map<string, { id: number; name: string }>
  stateByName: Map<string, { code: string; name: string; id: string }>
  stateByCode: Map<string, { name: string; id: string }>
}
let lookupCache: { at: number; lk: SearchLookups } | null = null
const LOOKUP_TTL_MS = 5 * 60 * 1000

async function getLookups(payload: any, pool: any): Promise<SearchLookups> {
  if (lookupCache && Date.now() - lookupCache.at < LOOKUP_TTL_MS) return lookupCache.lk

  const [treatmentsRes, brandsRes, statesRes] = await Promise.all([
    payload.find({ collection: 'services', limit: 200, depth: 0 }),
    payload.find({ collection: 'brands', limit: 200, depth: 0 }),
    payload.find({ collection: 'locations', where: { kind: { equals: 'state' } }, limit: 200, depth: 0 }),
  ])

  const treatments = (treatmentsRes.docs as any[]).map((t) => ({
    id: Number(t.id),
    name: String(t.name),
    slug: String(t.slug),
  }))
  const slugToTreatment = new Map<string, { id: number; name: string }>()
  for (const t of treatments) slugToTreatment.set(t.slug, { id: t.id, name: t.name })

  const treatmentPhraseToSlug = buildServiceLookup(treatments)

  const brands = (brandsRes.docs as any[]).map((b) => ({
    id: Number(b.id),
    name: String(b.name),
    slug: String(b.slug),
  }))
  const slugToBrand = new Map<string, { id: number; name: string }>()
  for (const b of brands) slugToBrand.set(b.slug, { id: b.id, name: b.name })

  const brandPhraseToSlug = buildBrandLookup(brands)

  const stateByName = new Map<string, { code: string; name: string; id: string }>()
  const stateByCode = new Map<string, { name: string; id: string }>()
  const locationPhrases = new Set<string>()
  for (const s of statesRes.docs as any[]) {
    if (s.name && s.state) {
      const name = String(s.name).toLowerCase()
      const code = String(s.state).toLowerCase()
      stateByName.set(name, { code: s.state, name: s.name, id: String(s.id) })
      stateByCode.set(code, { name: s.name, id: String(s.id) })
      // Only full state NAMES go into the omnibox location lookup. Bare 2-letter
      // codes ("pa", "or", "in", "me") collide with credentials + English words,
      // so the parser must not treat them as locations. stateByCode is still used
      // to resolve an EXPLICIT location param (the legacy two-field path).
      locationPhrases.add(name)
    }
  }

  // Known cities + neighborhoods come from the clinic data itself, so any place we
  // actually have providers in is recognized as a location (not a name).
  try {
    const places = await pool.query(
      `SELECT lower(city) AS v FROM clinics WHERE city IS NOT NULL
       UNION SELECT lower(neighborhood) FROM clinics WHERE neighborhood IS NOT NULL`,
    )
    for (const row of places.rows) if (row.v) locationPhrases.add(String(row.v))
  } catch {
    /* clinics table unavailable -> location matching falls back to states only */
  }

  // The metro override spellings must be recognisable AS locations, or the
  // parser never hands them to the resolver. "new york" already arrives via the
  // clinic city list; "new york city" and "nyc" do not appear in any city column
  // and would otherwise be parsed as name text.
  for (const phrase of Object.keys(STATE_NAME_METRO_OVERRIDES)) locationPhrases.add(phrase)

  // Spelling-tolerant keys over the same dictionaries (lib/search-intent.ts).
  const tolerant = buildTolerantLookups({
    treatmentPhraseToSlug,
    brandPhraseToSlug,
    serviceSlugs: new Set(treatments.map((t) => t.slug)),
    brandSlugs: new Set(brands.map((b) => b.slug)),
  })

  const lk: SearchLookups = {
    intent: { treatmentPhraseToSlug, brandPhraseToSlug, locationPhrases, tolerant },
    slugToTreatment,
    slugToBrand,
    stateByName,
    stateByCode,
  }
  lookupCache = { at: Date.now(), lk }
  return lk
}

export async function searchDirectory(params: SearchParams): Promise<SearchResult> {
  const payload = await getPayloadInstance()
  const pool = (payload.db as any).pool
  const slugMap = await getLocationSlugMap()

  const rawQ = (params.q ?? '').trim()
  const explicitTreatment = (params.treatment ?? '').trim()
  const explicitLocation = (params.location ?? '').trim()
  const page = Math.max(1, params.page ?? 1)
  const limit = Math.min(Math.max(1, params.limit ?? 24), 100)
  const allowGeocode = params.allowGeocode ?? false
  const filters = sanitizeListingFilters(params.filters)
  const filtersActive = hasSearchListingFilters(filters)

  // One-time PostGIS check. PostGIS is confirmed unavailable (not just
  // uninstalled) on the production DigitalOcean cluster, so geo search no
  // longer depends on it: when absent, the Haversine SQL fallback below is
  // used instead of ST_DWithin/ST_Distance. `hasGeo` now means "we have
  // coordinates to filter by," independent of which SQL expression computes it.
  const geoEnabled = await isPostGisAvailable(pool)

  let hasGeo = Number.isFinite(params.lat) && Number.isFinite(params.lng)
  let lat = hasGeo ? (params.lat as number) : undefined
  let lng = hasGeo ? (params.lng as number) : undefined
  let radiusMeters = (params.radiusMiles ?? DEFAULT_RADIUS_MILES) * METERS_PER_MILE
  // Set when the search centre comes from a ZIP (typed, in the location field,
  // or the visitor's own for "near me"). With no radius passed in, such a search
  // runs ZIP first on ZIP_SEARCH_RADIUS_LADDER instead of a flat 25 miles.
  let zipCenter: string | undefined

  const empty: SearchResult = {
    clinics: [],
    clinicTotal: 0,
    page,
    limit,
    center: hasGeo ? { lat: lat!, lng: lng! } : null,
  }

  // Nothing to search on -> return empty (never dump the whole table).
  if (!rawQ && !explicitTreatment && !explicitLocation && !hasGeo) return empty

  const lk = await getLookups(payload, pool)

  // ── Parse the omnibox query into intent ──────────────────────────────────
  const parsed: ParsedIntent = rawQ
    ? parseSearchQuery(rawQ, lk.intent, { exactOnly: params.exactParse })
    : { freeText: '' }
  // Whether spelling tolerance, a dropped noise word or "near me" shaped this
  // search. Such a search that finds nothing is re-run the old way at the end.
  let usedTolerance = !!parsed.tolerant

  // ── Resolve treatment (explicit param wins, else parsed) ─────────────────
  let treatmentId: number | undefined
  let treatmentLabel: string | undefined
  let treatmentSlug = parsed.treatmentSlug
  if (explicitTreatment) {
    const phrase = explicitTreatment.toLowerCase()
    treatmentSlug = lk.intent.treatmentPhraseToSlug.get(phrase) ?? slugify(explicitTreatment)
    // Same tolerance for the legacy `treatment` param ("lip fillers").
    if (!lk.slugToTreatment.has(treatmentSlug) && !params.exactParse && lk.intent.tolerant) {
      const tolerantSlug = resolveTolerant(explicitTreatment, lk.intent.tolerant, 'treatment')
      if (tolerantSlug) {
        treatmentSlug = tolerantSlug
        usedTolerance = true
      }
    }
  }
  if (treatmentSlug) {
    const t = lk.slugToTreatment.get(treatmentSlug)
    if (t) {
      treatmentId = t.id
      treatmentLabel = t.name
    } else if (explicitTreatment) {
      // An explicit treatment was requested but does not exist -> no results.
      return { ...empty, serviceLabel: explicitTreatment }
    }
  }

  // ── Resolve brand (product) from the parsed query, e.g. "juvederm" ───────
  let brandId: number | undefined
  let brandLabel: string | undefined
  if (parsed.brandSlug) {
    const b = lk.slugToBrand.get(parsed.brandSlug)
    if (b) {
      brandId = b.id
      brandLabel = b.name
    }
  }

  // ── Resolve location text -> state code OR city/neighborhood LIKE ─────────
  const locationQ = explicitLocation || parsed.location || ''
  let stateCode: string | undefined
  let stateLocationId: string | undefined
  let cityLike: string | undefined
  let locationLabel: string | undefined
  if (locationQ && !hasGeo) {
    const lc = locationQ.toLowerCase()
    // Extract a standalone 5-digit ZIP from anywhere in the string, not just an
    // exact full match -- the location field is often filled with a compound
    // label like "77098, Houston, TX" (picked from a ZIP suggestion, or from
    // IP-based city detection), which the old exact-match check silently missed,
    // falling through to a cityLike text filter that could never match anything.
    const zipMatch = lc.match(/(?:^|\D)(\d{5})(?:\D|$)/)
    if (zipMatch) {
      const zip5 = zipMatch[1]
      // ZIP: try the offline zip_codes table first (fast, no network).
      // Fall back to the geocoder if not in our dataset.
      const offlineHit = await lookupZip(zip5, pool)
      if (offlineHit) {
        lat = offlineHit.lat
        lng = offlineHit.lng
        hasGeo = true
        locationLabel = offlineHit.label
        zipCenter = zip5
      } else if (allowGeocode) {
        const hit = await geocode(zip5)
        if (hit) {
          lat = hit.lat
          lng = hit.lng
          hasGeo = true
          locationLabel = hit.label
          zipCenter = zip5
        } else {
          cityLike = `%${lc}%`
          locationLabel = locationQ
        }
      } else {
        cityLike = `%${lc}%`
        locationLabel = locationQ
      }
    } else if (STATE_NAME_METRO_OVERRIDES[lc]) {
      // Checked BEFORE stateByName, which is the whole point: the state reading
      // is what this is overriding. Coordinates are constants, so there is no
      // geocoder call and no network on this path.
      const m = STATE_NAME_METRO_OVERRIDES[lc]
      lat = m.lat
      lng = m.lng
      hasGeo = true
      radiusMeters = (params.radiusMiles ?? m.radiusMiles) * METERS_PER_MILE
      locationLabel = m.label
    } else if (lk.stateByName.has(lc)) {
      const m = lk.stateByName.get(lc)!
      stateCode = m.code
      stateLocationId = m.id
      locationLabel = m.name
    } else if (lk.stateByCode.has(lc)) {
      const m = lk.stateByCode.get(lc)!
      stateCode = lc.toUpperCase()
      stateLocationId = m.id
      locationLabel = m.name
    } else {
      // Compound "City, ST" / "City, State Name" labels -- exactly what the
      // location autocomplete suggests and what a clicked suggestion submits
      // -- never match a bare `city` column value as one LIKE pattern
      // ("houston, tx" != "Houston"), silently returning zero results for the
      // site's own suggestion. Split off a trailing state and match it
      // separately; keep just the city portion as the LIKE pattern.
      const commaIdx = lc.lastIndexOf(',')
      const cityPart = commaIdx > 0 ? lc.slice(0, commaIdx).trim() : lc
      const statePart = commaIdx > 0 ? lc.slice(commaIdx + 1).trim() : ''
      if (statePart && lk.stateByCode.has(statePart)) {
        const m = lk.stateByCode.get(statePart)!
        stateCode = statePart.toUpperCase()
        stateLocationId = m.id
      } else if (statePart && lk.stateByName.has(statePart)) {
        const m = lk.stateByName.get(statePart)!
        stateCode = m.code
        stateLocationId = m.id
      }
      cityLike = `%${cityPart}%`
      locationLabel = locationQ
    }
  } else if (hasGeo) {
    locationLabel = locationQ || undefined
  }

  // ── "near me" -> the visitor's own ZIP, when nothing else names a place ───
  // A typed place, a ZIP or coordinates always win. Without a visitorLocation
  // (a cached response, a bot, a visitor outside the US) the phrase is simply
  // dropped and the search runs nationwide, which is what it did before minus
  // the zero-result name match on "near" and "me".
  if (parsed.nearMe && !locationQ && !hasGeo && !parsed.zip && params.visitorLocation) {
    const here = await params.visitorLocation().catch(() => null)
    if (here && Number.isFinite(here.lat) && Number.isFinite(here.lng)) {
      lat = here.lat
      lng = here.lng
      hasGeo = true
      locationLabel = here.label
      zipCenter = safeZip(here.zip)
    }
  }

  // ── ZIP / free-text -> free-text query (+ optional geocoding) ─────────────
  // When geocoding is allowed, a ZIP becomes a radius search. When it is not
  // (live as-you-type), the ZIP is folded back into the text query so it still
  // matches clinics by their zip column (zip is in the clinic tsvector).
  let freeText = parsed.freeText
  if (parsed.zip && !hasGeo) {
    // Try offline ZIP lookup first; geocoder as fallback.
    const offlineZip = await lookupZip(parsed.zip, pool)
    if (offlineZip) {
      lat = offlineZip.lat
      lng = offlineZip.lng
      hasGeo = true
      locationLabel = locationLabel || offlineZip.label
      zipCenter = parsed.zip
    } else if (allowGeocode) {
      const hit = await geocode(parsed.zip)
      if (hit) {
        lat = hit.lat
        lng = hit.lng
        hasGeo = true
        locationLabel = locationLabel || hit.label
        zipCenter = parsed.zip
      } else {
        freeText = [freeText, parsed.zip].filter(Boolean).join(' ')
      }
    } else if (!treatmentId && !stateCode && !cityLike) {
      // Live (no-geo) mode: only fold a bare ZIP into the text query when it is the
      // sole signal (so a pure ZIP still matches a clinic by its zip column).
      // When combined with a treatment/location, drop it here; the submit path
      // (geo=1) turns it into a radius search.
      freeText = [freeText, parsed.zip].filter(Boolean).join(' ')
    }
  }

  // A ZIP-centred search with no radius passed in starts at the first rung.
  zipCenter = safeZip(zipCenter)
  const zipLadder = !!zipCenter && params.radiusMiles == null
  if (zipLadder) radiusMeters = ZIP_SEARCH_RADIUS_LADDER[0] * METERS_PER_MILE

  let tsquery = freeText ? toPrefixTsQuery(freeText) : ''

  const toMiles = (m?: number) =>
    m != null ? Math.round((m / METERS_PER_MILE) * 10) / 10 : undefined

  // Radius WHERE clause + distance expression, picking PostGIS (indexed) when
  // available or the Haversine fallback (search-sql.ts) when it is not. Shared
  // by providerCandidates/clinicCandidates so the two never drift apart.
  function geoSql(alias: string): { whereClause: string | null; distExpr: string } {
    if (!hasGeo) return { whereClause: null, distExpr: 'NULL' }
    const a = alias ? `${alias}.` : ''

    // The predicate `clinics_geog_idx` was CREATEd with. Postgres will only use a
    // PARTIAL index when the query's WHERE provably implies that index's own
    // WHERE, and this one has never been stated here, so every radius search
    // sequential-scanned all 57,591 published clinics building a geography per
    // row. Measured on staging 2026-09-05 for a 25-mile search around 77098:
    //
    //   top-124 by score   5,350ms Seq Scan  ->    70ms Index Scan
    //   count(*)           3,949ms Seq Scan  ->     5ms Index Scan
    //   rows returned      1,067 either way, identical
    //
    // It costs nothing semantically. A NULL coordinate makes ST_MakePoint NULL,
    // so ST_DWithin is NULL and the row was already excluded; a (0,0) row sits
    // in the Gulf of Guinea and is outside any US radius. The index was built on
    // exactly that reasoning, and this restates it where the planner can see it.
    const hasCoords =
      `${a}latitude IS NOT NULL AND ${a}longitude IS NOT NULL ` +
      `AND ${a}latitude <> 0 AND ${a}longitude <> 0`

    // ZIP-centred search (2026-09-28): the radius OR the ZIP's own clinics.
    // The ZIP half is boxed like the near-me listing's, so it stays on the
    // latitude index; an unbounded "OR zip = X" scans the whole table. zipCenter
    // is five digits (safeZip), so it is safe as a literal.
    // Without a ZIP the clause is exactly what it always was.
    const withZip = (radiusClause: string) =>
      zipLadder
        ? `(${radiusClause} OR (${clinicBoundingBoxSql(lat!, lng!, NEAR_ME_ZIP_REACH_MILES, alias)} AND ${a}zip = '${zipCenter}'))`
        : radiusClause

    if (geoEnabled) {
      return {
        whereClause: withZip(`(${hasCoords} AND ST_DWithin(${clinicGeog(alias)}, geography(ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)), ${radiusMeters}))`),
        distExpr: clinicDistanceMeters(lat!, lng!, alias),
      }
    }

    // No PostGIS: there is no GIST index to unlock, so the bounding box does the
    // narrowing instead, off the plain latitude/longitude btrees, and the
    // haversine only refines what survives. Same reasoning as the listing radius
    // filter; see boundingBoxForRadius in search-sql.ts.
    const distExpr = clinicDistanceMetersHaversine(lat!, lng!, alias)
    const box = clinicBoundingBoxSql(lat!, lng!, radiusMeters / METERS_PER_MILE, alias)
    return { whereClause: withZip(`(${hasCoords} AND ${box} AND ${distExpr} <= ${radiusMeters})`), distExpr }
  }

  // ── Clinic candidate query ───────────────────────────────────────────────
  // WHERE clause for the current interpretation of the query. `applyFilters`
  // adds the listing-panel filters; with it false (or no filters set) the SQL
  // is exactly what it was before the filters existed, clause for clause and
  // parameter for parameter, so an unfiltered search cannot change.
  function candidateWhere(applyFilters: boolean): {
    params: any[]
    whereSql: string
    distExpr: string
    rankExpr: string
  } {
    const params: any[] = []
    const bind = (v: any) => {
      params.push(v)
      return `$${params.length}`
    }
    const tsqRef = tsquery ? bind(tsquery) : ''
    const where: string[] = ["c.status = 'published'"]
    if (treatmentId !== undefined) {
      // The clinic's OWN offered services (clinics_rels), not its providers'.
      // Clinics carry servicesOffered directly; filtering through providers
      // returned nothing (there are no providers yet) so every clinic was dropped.
      where.push(
        `EXISTS (SELECT 1 FROM clinics_rels cr WHERE cr.parent_id = c.id AND cr.path = 'servicesOffered' AND cr.services_id = ${bind(
          treatmentId,
        )})`,
      )
    }
    if (brandId !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM clinics_rels cr WHERE cr.parent_id = c.id AND cr.path = 'brandsOffered' AND cr.brands_id = ${bind(
          brandId,
        )})`,
      )
    }
    if (tsquery) {
      where.push(`${clinicTsv('c')} @@ to_tsquery('english', ${tsqRef})`)
    }
    if (stateCode) where.push(`c.state = ${bind(stateCode)}`)
    // ILIKE, not lower(...) LIKE. Wrapping the column in lower() is exactly what
    // stops the gin_trgm_ops index on clinic city/neighborhood text from
    // applying, so this seq-scanned all 57,591 published clinics on every
    // city-name search. Measured on staging 2026-09-05 for '%houston%':
    // 763ms Seq Scan -> 237ms, returning the identical 454 rows both ways.
    // `cityLike` is already lowercased by the caller and ILIKE is
    // case-insensitive, so the comparison itself is unchanged. Same fix the
    // suggest route made for clinic_name on 2026-08-17.
    if (cityLike) where.push(`(c.city ILIKE ${bind(cityLike)} OR c.neighborhood ILIKE ${bind(cityLike)})`)
    const clinicGeo = geoSql('c')
    if (clinicGeo.whereClause) where.push(clinicGeo.whereClause)
    if (applyFilters && filtersActive) {
      // Same SQL as fetchLeanClinics (lib/lean-clinic-listing.ts), so a filter
      // means the same thing on /search as on every other listing: OR within
      // brands, OR within services, AND across the groups.
      if (filters.brandIds?.length) {
        where.push(
          `EXISTS (SELECT 1 FROM clinics_rels cr WHERE cr.parent_id = c.id AND cr.path = 'brandsOffered' AND cr.brands_id = ANY(${bind(
            filters.brandIds,
          )}::int[]))`,
        )
      }
      if (filters.serviceIds?.length) {
        where.push(
          `EXISTS (SELECT 1 FROM clinics_rels cr WHERE cr.parent_id = c.id AND cr.path = 'servicesOffered' AND cr.services_id = ANY(${bind(
            filters.serviceIds,
          )}::int[]))`,
        )
      }
      if (filters.clinicTypes?.length) {
        // clinic_type is an enum; cast the column, never the array (see
        // fetchLeanClinics for why).
        where.push(`c.clinic_type::text = ANY(${bind(filters.clinicTypes)}::text[])`)
      }
      if (filters.minRating != null) {
        where.push(`c.aggregate_rating >= ${bind(filters.minRating)}`)
      }
      const { radiusMiles: fRadius, lat: fLat, lng: fLng } = filters
      if (fRadius != null && fLat != null && fLng != null) {
        // The visitor's Distance choice, around the point the panel wrote to
        // the url. Independent of any search centre above: a ZIP search keeps
        // its own radius and this narrows it further. Box first (indexed
        // columns), exact distance second. lat/lng/radius are numbers checked
        // by sanitizeListingFilters, so interpolating them is safe, which is
        // the same contract the helpers in search-sql.ts document.
        const filterDist = geoEnabled
          ? clinicDistanceMeters(fLat, fLng, 'c')
          : clinicDistanceMetersHaversine(fLat, fLng, 'c')
        where.push(clinicBoundingBoxSql(fLat, fLng, fRadius, 'c'))
        where.push(`${filterDist} <= ${fRadius * METERS_PER_MILE}`)
      }
    }
    const distExpr = clinicGeo.distExpr
    const rankExpr = tsquery ? `ts_rank(${clinicTsv('c')}, to_tsquery('english', ${tsqRef}))` : 'NULL'
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    return { params, whereSql, distExpr, rankExpr }
  }

  /**
   * Whether the query, WITHOUT the listing filters, matches anything.
   *
   * The clinic-name rescue and the place-name fallback below both re-read the
   * query when it matched nothing. A filter that empties a perfectly good
   * search ("houston" plus a brand no Houston clinic carries) must not trigger
   * that, or "houston" would be re-read as a clinic name and the visitor would
   * get clinics called Houston somewhere else. So when filters are on, the
   * re-read only happens if the unfiltered query also matched nothing, which
   * is exactly when it happened before filters existed.
   */
  async function unfilteredMatchExists(): Promise<boolean> {
    const { params, whereSql } = candidateWhere(false)
    const res = await pool.query(`SELECT 1 FROM clinics c ${whereSql} LIMIT 1`, params)
    return res.rows.length > 0
  }

  async function clinicCandidates(): Promise<{
    ids: number[]
    dist: Map<number, number>
    rank: Map<number, number>
    /** Clinics matching the filters. Equals ids.length on the unranked path. */
    total: number
    /** Candidate ids in the centre ZIP (zipLadder only). */
    inZip: Set<number>
    /** How many of `total` are in the centre ZIP (zipLadder only, else 0). */
    zipTotal: number
  }> {
    const { params, whereSql, distExpr, rankExpr } = candidateWhere(true)
    // ZIP-centred: the ZIP's own clinics first (2026-09-28). A literal, see safeZip.
    const zipExpr = zipLadder ? `(c.zip = '${zipCenter}')` : null

    // Two candidate strategies.
    //
    // Default (unranked): take any CANDIDATE_CAP rows and let JS rank those.
    // For a filter matching more than the cap that is a ranking of an arbitrary
    // slice, and `total` is the cap rather than the real number of matches.
    //
    // SEARCH_RANKED_SQL=1: order the FULL match set by the same blended score
    // rankClinics uses (lib/search-ranking-sql.ts) and take only the rows this
    // page needs plus a margin, and count the matches for real. JS ranking still
    // runs afterwards and still decides the final order; see that file for why.
    const ranked = rankedSqlEnabled()
    const orderBy = ranked
      ? `ORDER BY ${zipExpr ? `${zipExpr} DESC, ` : ''}${blendedScoreSql('c', {
          distExpr: hasGeo ? distExpr : null,
          tsRankExpr: tsquery ? rankExpr : null,
        })} DESC, c.id DESC`
      : ''
    // Enough rows to fill the requested page, plus a margin so a float
    // difference between Postgres numeric and JS double can only ever reorder
    // rows near the fetch boundary, never rows the visitor sees. Still capped by
    // CANDIDATE_CAP so a deep page cannot ask for an unbounded set.
    const fetchLimit = ranked
      ? Math.min(CANDIDATE_CAP, page * limit + RANKED_FETCH_MARGIN)
      : CANDIDATE_CAP

    const sql = `SELECT c.id AS id, ${distExpr} AS dist_m, ${rankExpr} AS text_rank${zipExpr ? `, ${zipExpr} AS in_zip` : ''}
                 FROM clinics c
                 ${whereSql}
                 ${orderBy}
                 LIMIT ${fetchLimit}`
    const res = await pool.query(sql, params)
    const dist = new Map<number, number>()
    const rank = new Map<number, number>()
    const inZip = new Set<number>()
    const ids: number[] = []
    for (const row of res.rows) {
      const id = Number(row.id)
      ids.push(id)
      if (row.dist_m != null) dist.set(id, Number(row.dist_m))
      if (row.text_rank != null) rank.set(id, Number(row.text_rank))
      if (row.in_zip === true) inZip.add(id)
    }

    // The real match count. Measured on production for the largest filter
    // (q=botox, 51,074 matches): 72ms server-side, so this is cheap enough to
    // run per search and is what stops the UI reporting "3000" for everything.
    let total = ids.length
    let zipTotal = inZip.size
    if (ranked) {
      const countRes = await pool.query(
        `SELECT count(*)::int AS n${zipExpr ? `, count(*) FILTER (WHERE ${zipExpr})::int AS z` : ''} FROM clinics c ${whereSql}`,
        params,
      )
      total = Number(countRes.rows[0]?.n ?? ids.length)
      if (zipExpr) zipTotal = Number(countRes.rows[0]?.z ?? inZip.size)
    }

    return { ids, dist, rank, total, inZip, zipTotal }
  }

  // ── Hydrate + rank one pass ──────────────────────────────────────────────
  async function runPass(): Promise<{ clinics: SearchClinic[]; clinicTotal: number; zipTotal: number }> {
    let clinics: SearchClinic[] = []
    let clinicTotal = 0
    let zipTotal = 0
    {
      const { ids, dist, rank, total, inZip, zipTotal: zt } = await clinicCandidates()
      clinicTotal = total
      zipTotal = zt
      if (ids.length) {
        // Two ways to turn candidate ids into rows, same fields either way.
        // The lean path skips payload.find's unconditional relationship joins,
        // which are the whole cost of a broad search. Opt-in via
        // SEARCH_LEAN_HYDRATE=1; unset keeps the original path. See
        // lib/search-hydrate.ts for the measurements and the field parity list.
        const docs: any[] = leanHydrationEnabled()
          ? await leanHydrateClinics(pool, ids)
          : ((
              await payload.find({
                collection: 'clinics',
                where: { id: { in: ids } },
                depth: 0,
                limit: ids.length,
              })
            ).docs as any[])
        const mapped = docs.map((c) =>
          mapClinic(c, slugMap, 0, toMiles(dist.get(Number(c.id))), rank.get(Number(c.id))),
        )
        const rankedList = rankClinics(mapped, { useDistance: hasGeo, useText: !!tsquery })
        // ZIP-centred: the ZIP's own clinics lead, each group keeping the
        // ranking order (2026-09-28). Same order the SQL fetched them in.
        const ordered = inZip.size
          ? [
              ...rankedList.filter((c) => inZip.has(Number(c.id))),
              ...rankedList.filter((c) => !inZip.has(Number(c.id))),
            ]
          : rankedList
        clinics = ordered.slice((page - 1) * limit, page * limit)
      }
    }

    return { clinics, clinicTotal, zipTotal }
  }

  let pass = await runPass()

  // ── ZIP ladder ───────────────────────────────────────────────────────────
  // A ZIP-centred search whose ZIP and 3-mile radius hold nothing widens to
  // 10, 25, then 50 miles, stopping at the first rung with a result, exactly
  // like the near-me listings. Page 2 of the same search climbs the same way,
  // so it always pages the rung page 1 showed.
  if (zipLadder) {
    for (let i = 1; pass.clinicTotal === 0 && i < ZIP_SEARCH_RADIUS_LADDER.length; i++) {
      radiusMeters = ZIP_SEARCH_RADIUS_LADDER[i] * METERS_PER_MILE
      pass = await runPass()
    }
  }

  // ── Clinic-name rescue ───────────────────────────────────────────────────
  // `locationPhrases` is built from EVERY distinct city and neighborhood across
  // 57,600 clinics, so it contains thousands of ordinary words that are also
  // place names. parseSearchQuery consumes the first token matching any of
  // them, which silently turns part of a clinic's NAME into a location filter.
  // Measured on staging 2026-09-05:
  //
  //   "Ada West Dermatology"       -> location="ada"      -> 0 results
  //   "Sutton Dermatology"         -> location="sutton"   -> 0 results
  //   "Joseph Anthony Retreat Spa" -> location="anthony"  -> 0 results
  //
  // ("The Baton Rouge Clinic" survived only because that clinic really is in
  // Baton Rouge.) Searching a clinic by name is a normal thing for a visitor to
  // do, and it returned an empty page.
  //
  // The rescue runs ONLY when the guess produced nothing, so no query that
  // works today can change: a location the visitor typed into the location
  // field (explicitLocation) is never second-guessed, and a resolved ZIP or
  // coordinate pair is left alone. Brand and treatment survive the retry
  // because those come from exact matches against the Brands/Services tables,
  // not from a fuzzy word list.
  const locationWasGuessed = !!parsed.location && !explicitLocation
  // Kept so a rescue that also finds nothing does not wipe the place from the
  // heading: "Lip Filler in houston, 0 results" says more than "Lip Filler".
  const labelBeforeRescue = locationLabel
  let rescued = false
  if (
    pass.clinicTotal === 0 &&
    rawQ &&
    locationWasGuessed &&
    !hasGeo &&
    // Listing filters emptied a query that does match: that is a real "no
    // results", not a misread name. See unfilteredMatchExists.
    !(filtersActive && (await unfilteredMatchExists()))
  ) {
    // Put the misread words back into the name query and drop the filters they
    // produced.
    freeText = [parsed.freeText, parsed.location].filter(Boolean).join(' ').trim()
    tsquery = toPrefixTsQuery(freeText)
    stateCode = undefined
    cityLike = undefined
    locationLabel = undefined
    rescued = true
    if (tsquery) pass = await runPass()
  }

  // ── Place-name fallback ──────────────────────────────────────────────────
  // If a single free-text phrase matched no clinics by NAME, and
  // nothing else resolved (no treatment/location/zip/coords), it may be a place we
  // have no name match for (e.g. "newport beach"). Geocode it ONCE and re-run as a
  // radius search. Gated on allowGeocode so the live panel never geocodes a name.
  if (
    allowGeocode &&
    freeText &&
    pass.clinicTotal === 0 &&
    treatmentId === undefined &&
    brandId === undefined &&
    !stateCode &&
    !cityLike &&
    !hasGeo &&
    // Same guard as the rescue above: only a phrase that matches nothing on its
    // own is re-read as a place, never one a listing filter emptied.
    !(filtersActive && (await unfilteredMatchExists()))
  ) {
    const hit = await geocode(freeText)
    if (hit) {
      lat = hit.lat
      lng = hit.lng
      hasGeo = true
      radiusMeters = (params.radiusMiles ?? FALLBACK_RADIUS_MILES) * METERS_PER_MILE
      tsquery = '' // it was a place, not a name
      locationLabel = hit.label
      pass = await runPass()
    }
  }

  // Nothing found after the rescue either: show the place the visitor typed.
  if (rescued && pass.clinicTotal === 0 && !hasGeo) locationLabel = labelBeforeRescue

  // ── Safety net for the tolerant reading ─────────────────────────────────
  // A reading shaped by spelling tolerance, a dropped noise word or "near me"
  // that finds nothing is re-run exactly as search worked before 2026-09-28.
  // So the tolerance can only add results: a clinic whose NAME is
  // "Lip Fillers Studio" is still found by typing that name.
  // Not when a listing filter is what emptied it (the reading itself matches):
  // that zero is real, and the old reading would only lose the heading.
  if (
    usedTolerance &&
    !params.exactParse &&
    pass.clinicTotal === 0 &&
    !(filtersActive && (await unfilteredMatchExists()))
  ) {
    return searchDirectory({ ...params, exactParse: true })
  }

  return {
    clinics: pass.clinics,
    serviceLabel: treatmentLabel,
    brandLabel,
    locationLabel,
    clinicTotal: pass.clinicTotal,
    page,
    limit,
    center: hasGeo ? { lat: lat!, lng: lng! } : null,
    ...(zipLadder && zipCenter
      ? {
          zipNotice: {
            zip: zipCenter,
            zipCount: pass.zipTotal,
            radiusMiles: Math.round(radiusMeters / METERS_PER_MILE),
          },
        }
      : {}),
  }
}

/**
 * Brand + Service option lists for the /search page's filter sidebar (the same
 * `ListingFilters` component the FIND-path state/city hubs use — see
 * lib/location-queries.ts's StateHubData for the identical fetch shape).
 */
export type SearchFilterOptions = {
  brandOptions: { id: string; name: string }[]
  serviceOptions: { id: string; name: string }[]
}

/**
 * Memoised: the same two lists for every visitor, re-queried on every search
 * before 2026-09-05. See lib/ttl-memo.ts. Bypass with SEARCH_OPTION_CACHE=0.
 */
export const getSearchFilterOptions = ttlMemo(
  async function getSearchFilterOptions(): Promise<SearchFilterOptions> {
    const payload = await getPayloadInstance()
    const [brandsRes, servicesRes] = await Promise.all([
      payload.find({ collection: 'brands', limit: 100, depth: 0, sort: 'name' }),
      payload.find({ collection: 'services', limit: 100, depth: 0, sort: 'name' }),
    ])
    return {
      brandOptions: (brandsRes.docs as any[]).map((b) => ({ id: String(b.id), name: b.name })),
      serviceOptions: (servicesRes.docs as any[]).map((s) => ({ id: String(s.id), name: s.name })),
    }
  },
)
