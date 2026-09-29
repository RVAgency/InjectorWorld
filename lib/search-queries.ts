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
  queryWords,
  METERS_PER_MILE,
} from './search-sql'
import {
  parseSearchQuery,
  buildServiceLookup,
  buildBrandLookup,
  buildTolerantLookups,
  resolveTolerant,
  NAME_NOISE,
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
  /**
   * The panel's Distance, read from the same `radius` param (2026-09-29): miles,
   * or 'any' for an explicit "Any distance". Measured from the searched place
   * when the search has one. See SearchParams.distance.
   */
  distance?: SearchDistance
  filtersActive: boolean
}

/** The Distance picked in the /search filter panel. */
export type SearchDistance = number | 'any'

/** Largest radius /search accepts from the url. Above it the choice is ignored. */
const MAX_PANEL_RADIUS_MILES = 100

/** A url `radius` as a panel Distance, or undefined when it is missing or junk. */
function parseSearchDistance(raw: string | null): SearchDistance | undefined {
  const value = (raw ?? '').trim()
  if (value === 'any') return 'any'
  if (!value) return undefined
  const miles = Number(value)
  return Number.isFinite(miles) && miles > 0 && miles <= MAX_PANEL_RADIUS_MILES ? miles : undefined
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
  const distance = parseSearchDistance(sp.get('radius'))

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
    distance,
    // A Distance in miles narrows the list, so an empty result offers "Clear
    // filters" even when no coordinates travelled with it. "Any distance" only
    // ever widens, so it does not count.
    filtersActive: hasSearchListingFilters(filters) || typeof distance === 'number',
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
    distance: req.distance,
    // Only page 1 renders the filter panel that needs the search's own place.
    wantDistanceOrigin: page === 1,
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
   * The Distance picked in the /search filter panel (2026-09-29).
   *
   * When the search has a place of its own (a ZIP, New York City, a geocoded
   * place name, or a city), the Distance is measured from that place and
   * REPLACES the search's own reach: 10 on a ZIP search widens its 3-mile
   * default to 10 miles, and 10 on a city search means within 10 miles of the
   * city instead of clinics named after it. 'any' removes the limit (a ZIP
   * search still lists the ZIP's own clinics first). Until then the panel's
   * Distance was always measured from the visitor's IP location and could only
   * narrow what the search had found, so "botox miami" at 10 miles from a
   * Houston visitor returned nothing, and 10 miles on a ZIP search stayed at 3.
   *
   * A search with no place (a name, a treatment, a state) ignores this and
   * keeps the panel's own point in `filters`, as it always has.
   */
  distance?: SearchDistance
  /**
   * Return `distanceOrigin` (the point the panel measures Distance from). Costs
   * one extra, cached query for a city search, so only page 1 asks for it.
   */
  wantDistanceOrigin?: boolean
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
  /**
   * The point the filter panel measures Distance from (2026-09-29): the
   * search's own place, or the middle of a searched city's clinics. Null when
   * the search has no place, and the panel then uses the visitor's location.
   * Only set when `wantDistanceOrigin` was asked for.
   */
  distanceOrigin?: { lat: number; lng: number } | null
  /**
   * Radius in miles the list is actually limited to (the ZIP ladder's rung,
   * New York City's 25, a picked Distance), or null for none. The panel shows
   * it, so it never reads "Any distance" beside a list cut to 3 miles.
   */
  appliedRadiusMiles?: number | null
  /**
   * The list is nearest first (2026-09-30): a ZIP search, or a Distance picked
   * on a search with a place. The cards then show each clinic's distance. A
   * city, state or name search keeps its relevance order and shows none, so a
   * card never reads 0.5, 2.1, 0.8 mi down the page.
   */
  sortedByDistance?: boolean
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
 * Most clinics a query's "named with every typed word" match may add
 * (2026-09-29). More than this and the words are generic, not one clinic's
 * name; see matchTypedName.
 */
const NAMED_MATCH_MAX = 100

/**
 * Accent-free, lowercase form of a clinic name or a typed word (2026-09-29), so
 * "eternite" can find "Éternité" and "beaute evolution" can find "Beauté +
 * Évolution Spa". Postgres here has no unaccent extension, and the full-text
 * index is built on the names as stored, so this runs in JavaScript over the
 * short list of names that carry accents (see accentedNames).
 */
function foldAccents(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[œŒ]/g, 'oe')
    .replace(/[øØ]/g, 'o')
    .replace(/[łŁ]/g, 'l')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
}

const foldedWords = (s: string) => foldAccents(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** A typed name or clinic name compared as text: lowercase, single spaces. */
const nameKey = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Published clinics whose names carry accented letters, as accent-free words
 * (about 1,000 of 57,000 on staging, 2026-09-29). Loaded in the background and
 * kept for an hour: a search never waits for it, and until the first load
 * lands an accent-free query simply cannot reach an accented name, which is
 * how search behaved before this existed.
 */
/** `words`: every word, accent-free. `plain`: the ones that had no accent to begin with. */
type AccentedName = { id: number; words: string[]; plain: string[]; key: string }
const ACCENTED_TTL_MS = 60 * 60 * 1000
let accentedCache: { at: number; rows: AccentedName[] } | null = null
let accentedLoading: Promise<void> | null = null

function accentedNames(pool: any): AccentedName[] {
  const fresh = accentedCache && Date.now() - accentedCache.at < ACCENTED_TTL_MS
  if (!fresh && !accentedLoading) {
    accentedLoading = pool
      .query(`SELECT id, clinic_name FROM clinics WHERE status = 'published' AND clinic_name ~ '[^[:ascii:]]'`)
      .then((res: any) => {
        const rows: AccentedName[] = []
        for (const r of res.rows) {
          const name = String(r.clinic_name ?? '')
          // Only names an accent-free query could miss. A curly apostrophe or a
          // (R) sign changes nothing a typed word is matched against.
          if (foldAccents(name) === name.toLowerCase()) continue
          const original = name.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
          rows.push({
            id: Number(r.id),
            words: foldedWords(name),
            plain: original.filter((w) => foldAccents(w) === w),
            key: foldAccents(nameKey(name)),
          })
        }
        accentedCache = { at: Date.now(), rows }
      })
      .catch(() => {})
      .finally(() => {
        accentedLoading = null
      })
  }
  return accentedCache?.rows ?? []
}

/**
 * The middle of a searched city (2026-09-29): the median coordinates of the
 * published clinics in the city that the search's own location text matches
 * most often. "houston" also matches South Houston and Houston, MO; the median
 * of Houston, TX's 454 clinics is the answer. A median, not an average, so one
 * clinic geocoded to the wrong state cannot drag the point away. Null when no
 * matching clinic has coordinates.
 *
 * Location text only, never the treatment or name, so every search in one city
 * measures Distance from the same point. About 250ms on staging, so each answer
 * is kept for an hour, and concurrent callers share one query.
 */
const CITY_CENTRE_TTL_MS = 60 * 60 * 1000
const CITY_CENTRE_MAX = 2000
const cityCentreCache = new Map<
  string,
  { at: number; value: Promise<{ lat: number; lng: number } | null> }
>()

function cityCentre(
  pool: any,
  cityLike: string,
  stateCode: string | undefined,
): Promise<{ lat: number; lng: number } | null> {
  const key = `${cityLike}|${stateCode ?? ''}`
  const hit = cityCentreCache.get(key)
  if (hit && Date.now() - hit.at < CITY_CENTRE_TTL_MS) return hit.value
  const value = pool
    .query(
      `WITH m AS (
         SELECT c.city, c.state, c.latitude::float8 AS lat, c.longitude::float8 AS lng
         FROM clinics c
         WHERE c.status = 'published'
           AND (c.city ILIKE $1 OR c.neighborhood ILIKE $1)
           AND ($2::text IS NULL OR c.state = $2)
           AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL
           AND c.latitude <> 0 AND c.longitude <> 0
       ), top AS (
         SELECT city, state FROM m GROUP BY city, state
         ORDER BY count(*) DESC, city, state LIMIT 1
       )
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY m.lat) AS lat,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY m.lng) AS lng
       FROM m JOIN top ON m.city = top.city AND m.state = top.state`,
      [cityLike, stateCode ?? null],
    )
    .then((res: any) => {
      const row = res.rows[0]
      const lat = Number(row?.lat)
      const lng = Number(row?.lng)
      return row?.lat != null && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
    })
  // A failure is never cached: the next search asks again.
  value.catch(() => cityCentreCache.delete(key))
  if (cityCentreCache.size >= CITY_CENTRE_MAX) {
    const oldest = cityCentreCache.keys().next().value
    if (oldest !== undefined) cityCentreCache.delete(oldest)
  }
  cityCentreCache.set(key, { at: Date.now(), value })
  return value
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
  // The panel's Distance (see SearchParams.distance), checked like everything
  // else that reaches SQL as a literal.
  const pick: SearchDistance | undefined =
    params.distance === 'any'
      ? 'any'
      : typeof params.distance === 'number' &&
          Number.isFinite(params.distance) &&
          params.distance > 0 &&
          params.distance <= MAX_PANEL_RADIUS_MILES
        ? params.distance
        : undefined
  // A Distance in miles narrows the list like any other filter, whether or not
  // the panel's coordinates came with it.
  const filtersActive = hasSearchListingFilters(filters) || typeof pick === 'number'

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
  // "Any distance" picked on a search with a place: no radius at all.
  let radiusUnbounded = false

  /** The picked Distance replaces whatever radius the search chose for itself. */
  function applyPickedDistance() {
    if (pick === 'any') radiusUnbounded = true
    else if (pick !== undefined) {
      radiusUnbounded = false
      radiusMeters = pick * METERS_PER_MILE
    }
  }

  /** True when the search has its own place and the visitor picked a Distance. */
  function distanceFromPlace(): boolean {
    return hasGeo && pick !== undefined
  }

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

  // A ZIP-centred search with no radius passed in lists the ZIP's own clinics
  // first, and starts at the first rung of the ladder.
  zipCenter = safeZip(zipCenter)
  const zipFirst = !!zipCenter && params.radiusMiles == null
  if (zipFirst) radiusMeters = ZIP_SEARCH_RADIUS_LADDER[0] * METERS_PER_MILE
  // A Distance picked in the panel is measured from this place and replaces
  // the radius chosen above (the ZIP's rung, New York City's 25).
  if (distanceFromPlace()) applyPickedDistance()
  // Only the automatic radius climbs the ladder. A picked Distance is final:
  // an empty result under it is a real "no clinics within N miles".
  const zipLadder = zipFirst && pick === undefined

  /**
   * Nearest first (founder, 2026-09-30): a ZIP-centred search, or a Distance
   * picked around the search's own place (ZIP, city, NYC, geocoded place).
   * A city, state or name search on its own keeps its relevance order.
   * Evaluated when used, because a picked Distance can turn a city search
   * into a radius search further down.
   */
  function sortNearest(): boolean {
    return hasGeo && (zipFirst || distanceFromPlace())
  }

  let tsquery = freeText ? toPrefixTsQuery(freeText) : ''

  // ── The clinic the visitor typed by name (2026-09-29) ────────────────────
  // A word of a clinic's name that is also a treatment or a brand ("Optimal
  // Wellness St. Pete", "Lift Facial Aesthetics", "Radiesse Treatment Medspa")
  // is read as that treatment, so the search only looked at clinics TAGGED with
  // it and missed the clinic itself: 33 of 200 random clinic names were not
  // found by their own name on staging, most of them with zero results. Now:
  //   - a query that also has name words (freeText) and read a treatment or
  //     brand ALSO returns the clinics whose name holds every typed word, still
  //     inside the place the search named, and lists them first;
  //   - a clinic whose name is exactly what was typed is listed first on any
  //     name query ("My Spa" among 16,740 spa matches);
  //   - accent-free typing reaches accented names (see accentedNames).
  // A query with no name words ("botox houston", "lip filler 77098") never gets
  // here, so its SQL is exactly what it was.
  const treatmentFromQuery = !explicitTreatment && treatmentId !== undefined
  // The place phrase the query itself named; the location rescue gives it back
  // to the name.
  let placeInQuery = parsed.location
  // The place was read from the typed words, not the location field.
  const placeFromQuery = !explicitLocation && !!parsed.location
  // exact: clinics whose name is exactly what was typed, listed first.
  // accent: accented names the typed words reach only without the accents.
  // nameTsq: when a treatment or brand word was taken out of the name, every
  // clinic NAMED with all the typed words (a weight-A tsquery), listed next.
  type NameMatch = { exact: number[]; accent: number[]; nameTsq: string | null }
  const noNameMatch = (): NameMatch => ({ exact: [], accent: [], nameTsq: null })
  let nameMatch: NameMatch = noNameMatch()
  const hasTypedNameMatch = () =>
    nameMatch.exact.length > 0 || nameMatch.accent.length > 0 || nameMatch.nameTsq !== null

  /** The typed words that could be a clinic's name: all but the ZIP, the place and honorifics. */
  function typedNameWords(): string[] {
    if (!rawQ || parsed.nearMe) return []
    const words = queryWords(rawQ)
    if (parsed.zip) {
      const i = words.indexOf(parsed.zip)
      if (i >= 0) words.splice(i, 1)
    }
    if (placeInQuery) {
      const place = queryWords(placeInQuery)
      for (let i = 0; place.length && i + place.length <= words.length; i++) {
        if (place.every((w, k) => words[i + k] === w)) {
          words.splice(i, place.length)
          break
        }
      }
    }
    return words.filter((w) => !NAME_NOISE.has(w))
  }

  async function matchTypedName(): Promise<void> {
    nameMatch = noNameMatch()
    if (!freeText) return
    const words = typedNameWords()
    if (!words.length) return
    // A treatment or brand word was taken out of the name: look for the name.
    const mixed = (treatmentFromQuery && treatmentId !== undefined) || brandId !== undefined
    const typed = nameKey(parsed.zip ? rawQ.replace(parsed.zip, ' ') : rawQ)
    const accentFree = foldAccents(typed) === typed
    const folded = words.flatMap(foldedWords)
    // Only names the typed words reach BECAUSE the accents were dropped: every
    // word matches, and at least one of them matches only an accented word.
    // "spa" alone must not pull every "Beauté ... Spa" to the top.
    const accentIds = accentFree && folded.length
      ? accentedNames(pool)
          .filter(
            (r) =>
              folded.every((t) => r.words.some((w) => w.startsWith(t))) &&
              folded.some((t) => !r.plain.some((w) => w.startsWith(t))),
          )
          .slice(0, 50)
          .map((r) => r.id)
      : []
    // Applied inside the main query (see candidateWhere), so there is no cap
    // on how many clinics it can bring in and the total stays a real count.
    const nameTsq = mixed ? toPrefixTsQuery(words.join(' '), { nameOnly: true }) || null : null

    const p: any[] = []
    const b = (v: any) => {
      p.push(v)
      return `$${p.length}`
    }
    // The whole typed text as the name, case-insensitively. ILIKE with no
    // wildcard (they are escaped) is an equality test the trigram index on
    // clinic_name can answer, so this never scans the table.
    const typedRef = b(typed.replace(/[\\%_]/g, (ch) => `\\${ch}`))
    const exactExpr = `(c.clinic_name ILIKE ${typedRef})`
    const accentSql = accentIds.length ? `c.id = ANY(ARRAY[${accentIds.join(',')}]::int[])` : ''

    // Inside the place the search named, exactly as the reading applies it,
    // except that a place read out of the typed words themselves does not
    // bind a clinic whose whole name was typed: in "Newport Dermatology
    // Institute" the "Newport" is part of the name, and the clinic is in Costa
    // Mesa. A place typed in the location field, a ZIP and a picked Distance
    // still do. Built per branch, so every bound value is one the SQL uses
    // (Postgres refuses a parameter the statement never references).
    const geoWhere = geoSql('c').whereClause
    const placeSql = (forExactName: boolean): string => {
      const xs: string[] = []
      const bindsPlace = !(forExactName && placeFromQuery)
      if (stateCode && bindsPlace) xs.push(`c.state = ${b(stateCode)}`)
      if (cityLike && bindsPlace) {
        const ref = b(cityLike)
        xs.push(`(c.city ILIKE ${ref} OR c.neighborhood ILIKE ${ref})`)
      }
      if (geoWhere) xs.push(geoWhere)
      return xs.length ? xs.join(' AND ') : 'TRUE'
    }
    // The exact typed name, and the accented names, as ids. (The accented ones
    // are checked against the place again in the main query.)
    const branches = [`(${exactExpr} AND ${placeSql(true)})`]
    if (accentSql) branches.push(`(${accentSql} AND ${placeSql(false)})`)
    // How many clinics are NAMED with every typed word, counted only up to one
    // past NAMED_MATCH_MAX. Past it the words are generic ("Wellness Spa":
    // 1,300 names) rather than one clinic's name, and adding them all cost
    // 780 ms against 48 on staging; the exact name still leads either way.
    const namedCount = nameTsq
      ? `(SELECT count(*)::int FROM (SELECT 1 FROM clinics c WHERE c.status = 'published'
           AND ${clinicTsv('c')} @@ to_tsquery('english', ${b(nameTsq)}) AND ${placeSql(false)}
           LIMIT ${NAMED_MATCH_MAX + 1}) named)`
      : '0'
    // Room for a chain's many identically named branches (there are 240
    // "Massage Envy" clinics), which all rank as the exact name. One round
    // trip: the count comes back even when no clinic matched by name.
    const res = await pool.query(
      `WITH hits AS (
         SELECT c.id, c.clinic_name, ${exactExpr} AS exact FROM clinics c
         WHERE c.status = 'published' AND (${branches.join(' OR ')})
         ORDER BY exact DESC, c.id DESC LIMIT 1000
       )
       SELECT hits.id, hits.clinic_name, hits.exact, ${namedCount} AS named_n
       FROM (SELECT 1) one LEFT JOIN hits ON TRUE`,
      p,
    )
    const accentSet = new Set(accentIds)
    const typedFolded = foldAccents(typed)
    const next = noNameMatch()
    const namedN = Number(res.rows[0]?.named_n ?? 0)
    next.nameTsq = nameTsq && namedN > 0 && namedN <= NAMED_MATCH_MAX ? nameTsq : null
    for (const row of res.rows) {
      if (row.id == null) continue
      const id = Number(row.id)
      if (!Number.isInteger(id)) continue
      const folded = foldAccents(nameKey(String(row.clinic_name ?? '')))
      if (row.exact === true || (accentSet.has(id) && folded === typedFolded)) next.exact.push(id)
      else if (accentSet.has(id)) next.accent.push(id)
    }
    nameMatch = next
  }


  const toMiles = (m?: number) =>
    m != null ? Math.round((m / METERS_PER_MILE) * 10) / 10 : undefined

  // Radius WHERE clause + distance expression, picking PostGIS (indexed) when
  // available or the Haversine fallback (search-sql.ts) when it is not. Shared
  // by providerCandidates/clinicCandidates so the two never drift apart.
  function geoSql(
    alias: string,
    opts: { unbounded?: boolean } = {},
  ): { whereClause: string | null; distExpr: string } {
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
    // Without a ZIP the clause is exactly what it always was. A picked Distance
    // keeps the ZIP's own clinics too: the visitor searched for that ZIP.
    const withZip = (radiusClause: string) =>
      zipFirst
        ? `(${radiusClause} OR (${clinicBoundingBoxSql(lat!, lng!, NEAR_ME_ZIP_REACH_MILES, alias)} AND ${a}zip = '${zipCenter}'))`
        : radiusClause

    // No radius: "Any distance" picked, or the caller asking whether the search
    // matches anything at all (unfilteredMatchExists). Distance still ranks.
    if (radiusUnbounded || opts.unbounded) {
      return {
        whereClause: `(${hasCoords})`,
        distExpr: geoEnabled
          ? clinicDistanceMeters(lat!, lng!, alias)
          : clinicDistanceMetersHaversine(lat!, lng!, alias),
      }
    }

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
  function candidateWhere(
    applyFilters: boolean,
    opts: { withoutNameUnion?: boolean } = {},
  ): {
    params: any[]
    whereSql: string
    distExpr: string
    rankExpr: string
    /** Orders the clinic typed by name first; null when the query named none. */
    tierExpr: string | null
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
    // Everything from here to the panel filters is the PLACE.
    const placeStart = where.length
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
    // Without the filters, a picked Distance is left out too: it is one of them.
    const clinicGeo = geoSql('c', { unbounded: !applyFilters && distanceFromPlace() })
    if (clinicGeo.whereClause) where.push(clinicGeo.whereClause)
    // The clinics typed by name (matchTypedName) join the reading above; the
    // panel filters below still apply to them:
    //   (PLACE AND (reading OR named with every typed word OR accented name))
    //   OR exact typed name (already checked against its own place)
    // Ids are integers from the database, written as literals. With no name
    // match the SQL is exactly what it was.
    let tierExpr: string | null = null
    const typed = nameMatch
    if (!opts.withoutNameUnion && hasTypedNameMatch()) {
      const reading = where.slice(1, placeStart)
      const place = where.slice(placeStart)
      where.length = 1
      const alts = [reading.length ? `(${reading.join(' AND ')})` : 'TRUE']
      let namedSql = ''
      if (typed.nameTsq) {
        namedSql = `${clinicTsv('c')} @@ to_tsquery('english', ${bind(typed.nameTsq)})`
        alts.push(namedSql)
      }
      if (typed.accent.length) alts.push(`c.id = ANY(ARRAY[${typed.accent.join(',')}]::int[])`)
      const inPlace = `(${place.length ? `${place.join(' AND ')} AND ` : ''}(${alts.join(' OR ')}))`
      const exactSql = typed.exact.length ? `c.id = ANY(ARRAY[${typed.exact.join(',')}]::int[])` : ''
      where.push(exactSql ? `(${inPlace} OR ${exactSql})` : inPlace)
      const tiers: string[] = []
      if (exactSql) tiers.push(`WHEN ${exactSql} THEN 2`)
      if (namedSql) tiers.push(`WHEN ${namedSql} THEN 1`)
      if (tiers.length) tierExpr = `(CASE ${tiers.join(' ')} ELSE 0 END)`
    }
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
      if (fRadius != null && fLat != null && fLng != null && !distanceFromPlace()) {
        // The visitor's Distance choice, around the point the panel wrote to
        // the url, for a search with no place of its own (a name, a
        // treatment, a state). A search WITH a place measures the same choice
        // from that place instead, in geoSql (2026-09-29). Box first (indexed
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
    return { params, whereSql, distExpr, rankExpr, tierExpr }
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
  /**
   * Whether the reading ALONE matches anything, leaving out the clinics typed
   * by name. The location rescue asks this: a place word guessed out of a
   * clinic's name ("Ada West Dermatology") must still send the search back to
   * the name, with the heading that goes with it, even though the typed-name
   * match has already found the clinic. With no typed-name match it is the
   * same query as unfilteredMatchExists / the pass itself.
   */
  async function readingMatches(applyFilters: boolean): Promise<boolean> {
    const { params, whereSql } = candidateWhere(applyFilters, { withoutNameUnion: true })
    const res = await pool.query(`SELECT 1 FROM clinics c ${whereSql} LIMIT 1`, params)
    return res.rows.length > 0
  }

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
    /** Candidate ids typed by name: 2 exact name, 1 named with every typed word. */
    nameTier: Map<number, number>
  }> {
    const { params, whereSql, distExpr, rankExpr, tierExpr } = candidateWhere(true)
    // ZIP-centred: the ZIP's own clinics first (2026-09-28), under a picked
    // Distance as well. A literal, see safeZip.
    const zipExpr = zipFirst ? `(c.zip = '${zipCenter}')` : null

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
    // The clinic typed by name leads everything, then the ZIP's own clinics.
    // Nearest first where the search is about distance (sortNearest), the
    // blended relevance score everywhere else, exactly as before.
    const orderBy = ranked
      ? `ORDER BY ${tierExpr ? `${tierExpr} DESC, ` : ''}${zipExpr ? `${zipExpr} DESC, ` : ''}${
          sortNearest()
            ? `${distExpr} ASC NULLS LAST`
            : `${blendedScoreSql('c', {
                distExpr: hasGeo ? distExpr : null,
                tsRankExpr: tsquery ? rankExpr : null,
              })} DESC`
        }, c.id DESC`
      : ''
    // Enough rows to fill the requested page, plus a margin so a float
    // difference between Postgres numeric and JS double can only ever reorder
    // rows near the fetch boundary, never rows the visitor sees. Still capped by
    // CANDIDATE_CAP so a deep page cannot ask for an unbounded set.
    const fetchLimit = ranked
      ? Math.min(CANDIDATE_CAP, page * limit + RANKED_FETCH_MARGIN)
      : CANDIDATE_CAP

    const sql = `SELECT c.id AS id, ${distExpr} AS dist_m, ${rankExpr} AS text_rank${zipExpr ? `, ${zipExpr} AS in_zip` : ''}${
      tierExpr ? `, ${tierExpr} AS name_tier` : ''
    }
                 FROM clinics c
                 ${whereSql}
                 ${orderBy}
                 LIMIT ${fetchLimit}`
    const res = await pool.query(sql, params)
    const dist = new Map<number, number>()
    const rank = new Map<number, number>()
    const inZip = new Set<number>()
    const nameTier = new Map<number, number>()
    const ids: number[] = []
    for (const row of res.rows) {
      const id = Number(row.id)
      ids.push(id)
      if (row.dist_m != null) dist.set(id, Number(row.dist_m))
      if (row.text_rank != null) rank.set(id, Number(row.text_rank))
      if (row.in_zip === true) inZip.add(id)
      if (Number(row.name_tier) > 0) nameTier.set(id, Number(row.name_tier))
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

    return { ids, dist, rank, total, inZip, zipTotal, nameTier }
  }

  // ── Hydrate + rank one pass ──────────────────────────────────────────────
  async function runPass(): Promise<{ clinics: SearchClinic[]; clinicTotal: number; zipTotal: number }> {
    let clinics: SearchClinic[] = []
    let clinicTotal = 0
    let zipTotal = 0
    {
      const { ids, dist, rank, total, inZip, zipTotal: zt, nameTier } = await clinicCandidates()
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
        let ordered = inZip.size
          ? [
              ...rankedList.filter((c) => inZip.has(Number(c.id))),
              ...rankedList.filter((c) => !inZip.has(Number(c.id))),
            ]
          : rankedList
        // Ahead of that, the clinic typed by name (2026-09-29): its exact name
        // first, then names holding every typed word. A stable sort, so each
        // group keeps the order above.
        if (nameTier.size) {
          const tier = (c: SearchClinic) => nameTier.get(Number(c.id)) ?? 0
          ordered = [...ordered].sort((x, y) => tier(y) - tier(x))
        }
        // Nearest first (2026-09-30), in the same order as the SQL above: the
        // typed name, then the ZIP's own clinics, then the exact distance (not
        // the rounded miles, which tie), then id.
        if (sortNearest()) {
          const tier = (c: SearchClinic) => nameTier.get(Number(c.id)) ?? 0
          const zipRank = (c: SearchClinic) => (inZip.has(Number(c.id)) ? 1 : 0)
          const meters = (c: SearchClinic) => dist.get(Number(c.id)) ?? Number.POSITIVE_INFINITY
          ordered = [...rankedList].sort(
            (x, y) =>
              tier(y) - tier(x) ||
              zipRank(y) - zipRank(x) ||
              (meters(x) !== meters(y) ? (meters(x) < meters(y) ? -1 : 1) : 0) ||
              Number(y.id) - Number(x.id),
          )
        }
        clinics = ordered.slice((page - 1) * limit, page * limit)
      }
    }

    return { clinics, clinicTotal, zipTotal }
  }

  // ── City: the point Distance is measured from ────────────────────────────
  // Started now and left running beside the search. The panel needs it on
  // page 1, and a picked Distance in miles needs it to run at all.
  const cityCentreFor = cityLike
  const cityCentreP =
    cityLike && !hasGeo && (params.wantDistanceOrigin || typeof pick === 'number')
      ? cityCentre(pool, cityLike, stateCode).catch(() => null)
      : null

  // City search with a Distance in miles: within that many miles of the city's
  // middle, instead of clinics whose city is named like it, so 25 miles around
  // Houston reaches Sugar Land and Katy. Only when the location reading matches
  // on its own: a place word that was really part of a clinic's name ("Ada
  // West Dermatology") must still reach the name rescue below, which needs the
  // reading untouched.
  if (typeof pick === 'number' && cityCentreP && (await unfilteredMatchExists())) {
    const centre = await cityCentreP
    if (centre) {
      lat = centre.lat
      lng = centre.lng
      hasGeo = true
      applyPickedDistance()
      cityLike = undefined
      stateCode = undefined
    }
  }

  // With the reading settled (place, radius), look for the clinic typed by
  // name. Redone below whenever a rescue changes the reading.
  await matchTypedName()

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
    rawQ &&
    locationWasGuessed &&
    !hasGeo &&
    // The reading found nothing. Clinics found only by their typed name do
    // not count (see readingMatches); with none, this is the pass's own total.
    (hasTypedNameMatch() ? !(await readingMatches(true)) : pass.clinicTotal === 0) &&
    // Listing filters emptied a query that does match: that is a real "no
    // results", not a misread name. See unfilteredMatchExists.
    !(filtersActive && (await readingMatches(false)))
  ) {
    // Put the misread words back into the name query and drop the filters they
    // produced.
    freeText = [parsed.freeText, parsed.location].filter(Boolean).join(' ').trim()
    tsquery = toPrefixTsQuery(freeText)
    stateCode = undefined
    cityLike = undefined
    locationLabel = undefined
    rescued = true
    // The place words are name words again.
    placeInQuery = undefined
    await matchTypedName()
    if (tsquery) pass = await runPass()
  }

  // ── Treatment / brand rescue (2026-09-29) ────────────────────────────────
  // The same idea for a treatment or brand read out of a clinic's name. When
  // the reading AND the typed-name match both found nothing, the treatment or
  // brand word goes back into the name and the whole thing is searched as a
  // name, across every searchable field (name, tagline, city, street), inside
  // whatever place the search named: "Optimal Wellness St Petersburg", where
  // "St Petersburg" is the clinic's city and not part of its name. If that
  // finds nothing either, the original reading and its heading are kept.
  if (
    pass.clinicTotal === 0 &&
    rawQ &&
    ((treatmentFromQuery && treatmentId !== undefined) || brandId !== undefined) &&
    !(filtersActive && (await unfilteredMatchExists()))
  ) {
    const words = typedNameWords()
    if (words.length) {
      const before = { treatmentId, treatmentLabel, brandId, brandLabel, freeText, tsquery, nameMatch }
      treatmentId = undefined
      treatmentLabel = undefined
      brandId = undefined
      brandLabel = undefined
      freeText = words.join(' ')
      tsquery = toPrefixTsQuery(freeText)
      await matchTypedName()
      const retry = tsquery ? await runPass() : pass
      if (retry.clinicTotal > 0) pass = retry
      else ({ treatmentId, treatmentLabel, brandId, brandLabel, freeText, tsquery, nameMatch } = before)
    }
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
      // A picked Distance is measured from the place just found.
      if (distanceFromPlace()) applyPickedDistance()
      tsquery = '' // it was a place, not a name
      nameMatch = noNameMatch()
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

  // Where the panel measures Distance from: the search's own point, else the
  // middle of the searched city (only while the city reading still stands; the
  // name rescue drops it), else nowhere and the panel uses the visitor's.
  const distanceOrigin = !params.wantDistanceOrigin
    ? undefined
    : hasGeo
      ? { lat: lat!, lng: lng! }
      : cityLike && cityLike === cityCentreFor && cityCentreP
        ? await cityCentreP
        : null

  return {
    clinics: pass.clinics,
    serviceLabel: treatmentLabel,
    brandLabel,
    locationLabel,
    clinicTotal: pass.clinicTotal,
    page,
    limit,
    center: hasGeo ? { lat: lat!, lng: lng! } : null,
    ...(zipFirst && zipCenter && !radiusUnbounded
      ? {
          zipNotice: {
            zip: zipCenter,
            zipCount: pass.zipTotal,
            radiusMiles: Math.round(radiusMeters / METERS_PER_MILE),
          },
        }
      : {}),
    ...(distanceOrigin !== undefined ? { distanceOrigin } : {}),
    appliedRadiusMiles:
      hasGeo && !radiusUnbounded ? Math.round(radiusMeters / METERS_PER_MILE) : null,
    sortedByDistance: sortNearest(),
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
