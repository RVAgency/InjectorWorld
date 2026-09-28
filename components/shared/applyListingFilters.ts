export type ListingItemKind = 'provider' | 'clinic'

export type ListingFilterValues = {
  radius: number | null
  rating: number | null
  virtual: boolean
  priceMin: number
  priceMax: number
  languages: string[]
  clinicTypes: string[]
  loyaltyPrograms: string[]
  brands: string[]
  services: string[]
  lat: number | null
  lng: number | null
  /**
   * The visitor's ZIP, set ONLY by withNearMeDefault for the automatic near-me
   * radius (2026-09-28). Its clinics lead the list and stay in it even past the
   * radius. Never read from or written to the url: the ZIP stays out of the
   * address bar (docs/ZIP-NEAR-ME-LISTING-2026-09-10.md hard rule 3).
   */
  nearZip?: string | null
  /**
   * "Any distance" picked on purpose (2026-09-29, /search only). Distinct from
   * no Distance at all on a search that limits itself (a ZIP search's 3
   * miles), where "Any distance" lifts the limit. Travels as `radius=any`, and
   * only when the panel is told to write it (ListingFilters anyDistanceParam).
   * Nothing else reads it, so every other listing behaves exactly as before.
   */
  anyDistance?: boolean
}

export type ScoredListingResult<T> = {
  item: T
  score: number
  distanceMiles: number | null
}

export const PRICE_MIN = 0
export const PRICE_MAX = 2000

export const DEFAULT_LISTING_FILTERS: ListingFilterValues = {
  radius: null,
  rating: null,
  virtual: false,
  priceMin: PRICE_MIN,
  priceMax: PRICE_MAX,
  languages: [],
  clinicTypes: [],
  loyaltyPrograms: [],
  brands: [],
  services: [],
  lat: null,
  lng: null,
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : []
}

export function getListingCoordinates(item: unknown, kind: ListingItemKind): { lat: number; lng: number } | null {
  const root = asRecord(item)
  const source = kind === 'provider' ? asRecord(root.clinic) : root
  const lat = asNumber(source.latitude)
  const lng = asNumber(source.longitude)
  if (lat == null || lng == null || lat === 0 || lng === 0) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

export function getListingLanguages(item: unknown): string[] {
  return asStringArray(asRecord(item).languages)
}

export function getListingClinicType(item: unknown): string | undefined {
  const value = asRecord(item).clinicType
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function getListingLoyaltyPrograms(item: unknown): string[] {
  return asStringArray(asRecord(item).loyaltyPrograms)
}

export function getListingBrandIds(item: unknown): string[] {
  return asStringArray(asRecord(item).brandsOffered)
}

export function getListingServiceIds(item: unknown): string[] {
  const root = asRecord(item)
  // Clinics have servicesOffered (IDs); providers have treatmentIds (IDs)
  const fromServices = asStringArray(root.servicesOffered)
  const fromTreatments = asStringArray(root.treatmentIds)
  return fromServices.length > 0 ? fromServices : fromTreatments
}

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadiusMiles = 3959
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function intersects(values: string[], filters: string[]): boolean {
  if (filters.length === 0) return true
  const normalized = new Set(values.map((v) => v.toLowerCase()))
  return filters.some((v) => normalized.has(v.toLowerCase()))
}

function isVirtualMatch(item: unknown, kind: ListingItemKind): boolean {
  const root = asRecord(item)
  if (kind === 'provider') return root.offersVirtualConsult === true
  // Clinics no longer carry serviceType or offersVirtualConsult (both removed
  // 2026-08-23; serviceType was 'In-Person' on every row, offersVirtualConsult
  // was unused). No clinic can match a virtual-consult filter anymore.
  return false
}

export function applyListingFilters<T>(
  items: T[],
  filters: ListingFilterValues,
  kind: ListingItemKind,
): { items: T[]; scored: ScoredListingResult<T>[] } {
  const scored = items
    .map((item) => {
      const root = asRecord(item)
      const coords = getListingCoordinates(item, kind)
      const distanceMiles =
        filters.radius != null && filters.lat != null && filters.lng != null && coords
          ? haversineMiles(filters.lat, filters.lng, coords.lat, coords.lng)
          : null
      const rating = asNumber(root.aggregateRating) ?? 0
      const score = rating + (distanceMiles == null ? 0 : Math.max(0, 1 - distanceMiles / Math.max(filters.radius ?? 50, 1)))
      return { item, score, distanceMiles }
    })
    .filter(({ item, distanceMiles }) => {
      const root = asRecord(item)

      if (filters.radius != null && filters.lat != null && filters.lng != null) {
        // A clinic in the visitor's own ZIP stays even past the radius: the
        // server included it on purpose (it leads the near-me list).
        const keptForZip = Boolean(filters.nearZip) && root.inZip === true
        if (!keptForZip && (distanceMiles == null || distanceMiles > filters.radius)) return false
      }

      if (filters.rating != null && (asNumber(root.aggregateRating) ?? 0) < filters.rating) return false

      if (filters.virtual && !isVirtualMatch(item, kind)) return false

      const startingPrice = asNumber(root.startingPrice)
      if (startingPrice != null && (startingPrice < filters.priceMin || startingPrice > filters.priceMax)) return false

      if (!intersects(getListingLanguages(item), filters.languages)) return false

      if (kind === 'clinic' && filters.clinicTypes.length > 0) {
        const clinicType = getListingClinicType(item)
        if (!clinicType || !filters.clinicTypes.includes(clinicType)) return false
      }

      if (kind === 'provider' && !intersects(getListingLoyaltyPrograms(item), filters.loyaltyPrograms)) return false

      if (!intersects(getListingBrandIds(item), filters.brands)) return false

      if (!intersects(getListingServiceIds(item), filters.services)) return false

      return true
    })

  return { items: scored.map((r) => r.item), scored }
}

/**
 * The near-me default folded into the panel's filters (2026-09-10).
 *
 * Returns the filters UNCHANGED unless every condition holds: this listing is
 * one of the three pillar pages, a ZIP has been resolved, and the visitor has
 * not picked a distance themselves. That last one is the important one -- an
 * explicit choice in the filter panel always wins over the automatic default,
 * and it is also what keeps this reversible: pick a distance and the panel is
 * back in charge of both the radius and the point.
 *
 * This is deliberately NOT routed through ListingFilters.writeFilters(), which
 * pushes radius/lat/lng into the URL. The automatic default must never touch
 * the address bar; only a user action in the panel may.
 * See docs/ZIP-NEAR-ME-LISTING-2026-09-10.md hard rule 3.
 */
export function withNearMeDefault(
  filters: ListingFilterValues,
  near: {
    enabled: boolean
    ready: boolean
    lat: number | null
    lng: number | null
    /** Current rung of NEAR_ME_RADIUS_LADDER, or null once it is exhausted. */
    radius: number | null
    /** The visitor's ZIP. Its clinics lead the automatic near-me list. */
    zip?: string | null
  },
): ListingFilterValues {
  if (!near.enabled || !near.ready) return filters
  if (near.lat == null || near.lng == null) return filters
  if (filters.radius != null) return filters
  // Ladder exhausted: keep the visitor's point as the SORT origin so the
  // national list still opens with their own area, but stop filtering by a
  // radius that matched nothing.
  if (near.radius == null) return { ...filters, lat: near.lat, lng: near.lng }
  return { ...filters, lat: near.lat, lng: near.lng, radius: near.radius, nearZip: near.zip ?? null }
}

/**
 * The subset of the filters the listing APIs run in SQL, as query params.
 *
 * Added 2026-08-07. Filtering used to happen only in the browser, over the one
 * page of rows that happened to be loaded, so picking a brand out of 200 on a
 * 39,669-clinic listing almost always returned nothing.
 *
 * Radius joined them on 2026-08-08. The server narrows to a latitude/longitude
 * box around the point; applyListingFilters below still runs the exact haversine
 * on what comes back, which is what trims the box down to a real circle.
 *
 * Param names match what ListingFilters already writes to the URL, so a
 * filtered listing is still a shareable link.
 */
export function toServerFilterParams(filters: ListingFilterValues): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.brands.length > 0) params.set('brand', filters.brands.join(','))
  if (filters.services.length > 0) params.set('svc', filters.services.join(','))
  if (filters.clinicTypes.length > 0) params.set('type', filters.clinicTypes.join(','))
  if (filters.rating != null) params.set('rating', String(filters.rating))
  // Coordinates now travel even without a radius (2026-08-15). They used to be
  // sent only alongside `radius`, because distance was purely a filter. They
  // are also the origin the server orders the default listing around, so a
  // visitor who has set no filter at all still needs them to arrive; holding
  // them back until someone picks a radius is what kept the listing national.
  // Without `radius` the server treats the point as a sort origin only, and no
  // clinic is excluded.
  if (filters.lat != null && filters.lng != null) {
    params.set('lat', roundForCache(filters.lat))
    params.set('lng', roundForCache(filters.lng))
    if (filters.radius != null) {
      params.set('radius', String(filters.radius))
      // Near-me only (withNearMeDefault is the one place that sets nearZip):
      // the ZIP's clinics lead and are kept past the radius. This goes to the
      // listing API, never into the page url.
      if (filters.nearZip && /^\d{5}$/.test(filters.nearZip)) params.set('zip', filters.nearZip)
    }
  }
  return params
}

/**
 * Coordinates are rounded to 4 decimal places (about 11m) before they reach the
 * server (2026-09-12; was 2).
 *
 * Two decimals (about 1.1km) was chosen when results were grouped into 5-mile
 * distance bands, where a 1km shift almost never moved a clinic. That stopped
 * being true once a radius listing began ordering by the distance itself and
 * printing it on every card: the shift moved the origin up to 0.35 miles, and
 * the founder caught cards reading 0.3 mi for a clinic 0.6 mi from the ZIP in
 * the heading. Four decimals keeps the printed distance honest.
 *
 * The cache does not lose much. The near-me default now sends the centre of
 * the visitor's ZIP, so everyone in one ZIP shares one key. The point is a ZIP
 * centre or the geo provider's pin for an IP block, never the visitor's own
 * position, so nothing precise lands in URLs or logs.
 */
function roundForCache(value: number): string {
  return String(Number(value.toFixed(4)))
}

/** Stable string for effect deps: changes only when a server-handled filter does. */
export function serverFilterKey(filters: ListingFilterValues): string {
  return toServerFilterParams(filters).toString()
}

export function getActiveListingFilterCount(filters: ListingFilterValues): number {
  let count = 0
  if (filters.radius != null) count += 1
  if (filters.rating != null) count += 1
  if (filters.virtual) count += 1
  if (filters.priceMin !== PRICE_MIN || filters.priceMax !== PRICE_MAX) count += 1
  if (filters.languages.length > 0) count += 1
  if (filters.clinicTypes.length > 0) count += 1
  if (filters.loyaltyPrograms.length > 0) count += 1
  if (filters.brands.length > 0) count += 1
  if (filters.services.length > 0) count += 1
  return count
}
