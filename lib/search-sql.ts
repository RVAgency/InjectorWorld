/**
 * Shared raw-SQL fragments for search (Phase 5, expanded in Phase 13).
 *
 * The full-text and geography expressions here MUST match the ones indexed by
 * `scripts/setup-search-indexes.ts`, or Postgres cannot use the GIN / GIST
 * indexes. They are defined once here and imported by both the index script and
 * the query layer (`lib/search-queries.ts`).
 *
 * Functions take a table alias so the same expression works both in the index
 * (qualified with the real table name) and in a multi-table join query (qualified
 * with a short alias). Postgres resolves either to the same column Var, so the
 * index still applies.
 *
 * Phase 13: the tsvectors are now WEIGHTED (setweight A>B>C>D) so ts_rank can
 * order matches by where the hit landed (a name hit beats an address hit). The
 * clinic document gained the address columns (real columns on `clinics`).
 */

/**
 * Clinic full-text document. Weighted: A = clinic name, B = tagline,
 * C = neighborhood + city, D = street address + state + zip + county.
 * All of these are real columns on the `clinics` table.
 */
export function clinicTsv(alias = 'clinics'): string {
  const a = alias ? `${alias}.` : ''
  return `(
    setweight(to_tsvector('english', coalesce(${a}clinic_name,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(${a}tagline,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(${a}neighborhood,'')), 'C') ||
    setweight(to_tsvector('english', coalesce(${a}city,'')), 'C') ||
    setweight(to_tsvector('english', coalesce(${a}address_line1,'')), 'D') ||
    setweight(to_tsvector('english', coalesce(${a}state,'')), 'D') ||
    setweight(to_tsvector('english', coalesce(${a}zip,'')), 'D') ||
    setweight(to_tsvector('english', coalesce(${a}county,'')), 'D'))`
}

/** PostGIS geography point from a clinic's lat/lng (lng, lat order). */
export function clinicGeog(alias = 'clinics'): string {
  const a = alias ? `${alias}.` : ''
  return `geography(ST_SetSRID(ST_MakePoint(${a}longitude::double precision, ${a}latitude::double precision), 4326))`
}

/**
 * Great-circle distance in METERS from a clinic to a point.
 * `lat`/`lng` are interpolated as numeric literals (already validated/parsed by
 * the caller), never raw user text, so this is injection-safe.
 */
export function clinicDistanceMeters(lat: number, lng: number, alias = 'clinics'): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('Invalid coordinates: lat=' + lat + ' lng=' + lng)
  }
  // Interpolated directly — must be validated numbers, never raw user strings.
  return `ST_Distance(${clinicGeog(alias)}, geography(ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)))`
}

/**
 * Great-circle distance in METERS from a clinic to a point, computed with the
 * Haversine formula directly on the `latitude`/`longitude` columns. No PostGIS
 * required — this is the fallback used when the `postgis` extension is not
 * available on the database (confirmed unavailable, not just uninstalled, on
 * the current DigitalOcean managed Postgres cluster). At directory scale
 * (~10-15k clinics) an unindexed scan computing this per row is trivial; if
 * PostGIS ever becomes available, search-queries.ts prefers ST_Distance instead.
 *
 * `lat`/`lng` are interpolated as numeric literals (already validated/parsed by
 * the caller), never raw user text, so this is injection-safe — same contract
 * as clinicDistanceMeters above.
 */
export function clinicDistanceMetersHaversine(lat: number, lng: number, alias = 'clinics'): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('Invalid coordinates: lat=' + lat + ' lng=' + lng)
  }
  const a = alias ? `${alias}.` : ''
  const EARTH_RADIUS_METERS = 6371000
  return `(
    ${EARTH_RADIUS_METERS} * acos(
      LEAST(1.0, GREATEST(-1.0,
        cos(radians(${lat})) * cos(radians(${a}latitude::double precision)) *
        cos(radians(${a}longitude::double precision) - radians(${lng})) +
        sin(radians(${lat})) * sin(radians(${a}latitude::double precision))
      ))
    )
  )`
}

/**
 * Latitude/longitude box that fully contains a radius circle.
 *
 * Added 2026-08-07 for the listing radius filter. Both distance expressions
 * above compute trigonometry per row with nothing to index against on this
 * cluster (no PostGIS), which was fine at the ~10-15k clinics the comments were
 * written for and is not at 39,669. `latitude` and `longitude` are indexed
 * columns, so a plain BETWEEN on both trims the candidate set first and the
 * haversine only refines what survives.
 *
 * The box is deliberately generous: it is a square around the circle, so it
 * over-selects at the corners (about 27% more area). Callers that need the
 * exact circle apply the haversine as well; callers that cannot express
 * haversine (Payload `where` clauses) use the box alone and let the client trim.
 */
export function boundingBoxForRadius(
  lat: number,
  lng: number,
  radiusMiles: number,
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusMiles)) {
    throw new Error(`Invalid bounding box input: lat=${lat} lng=${lng} radius=${radiusMiles}`)
  }
  const MILES_PER_DEGREE_LAT = 69.0
  const latDelta = radiusMiles / MILES_PER_DEGREE_LAT
  // Degrees of longitude shrink towards the poles. The floor keeps the divisor
  // away from zero so an extreme latitude cannot produce an infinite box.
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180))
  const lngDelta = radiusMiles / (MILES_PER_DEGREE_LAT * cosLat)
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  }
}

/** The same box as a SQL fragment against a clinic alias. Numbers only, no user text. */
export function clinicBoundingBoxSql(
  lat: number,
  lng: number,
  radiusMiles: number,
  alias = 'clinics',
): string {
  const box = boundingBoxForRadius(lat, lng, radiusMiles)
  const a = alias ? `${alias}.` : ''
  return `(${a}latitude BETWEEN ${box.minLat} AND ${box.maxLat} AND ${a}longitude BETWEEN ${box.minLng} AND ${box.maxLng})`
}

/**
 * Whether the connected database has PostGIS. Cached for the process life.
 *
 * lib/nearby-clinics.ts and lib/search-queries.ts each carry their own copy of
 * this check; this one exists so new callers do not add a fourth. The existing
 * two are working and deliberately left alone.
 */
let _postgisAvailable: boolean | null = null
export async function isPostGisAvailable(pool: any): Promise<boolean> {
  if (_postgisAvailable !== null) return _postgisAvailable
  try {
    const res = await pool.query(`SELECT 1 FROM pg_proc WHERE proname = 'st_dwithin' LIMIT 1`)
    _postgisAvailable = res.rows.length > 0
  } catch {
    _postgisAvailable = false
  }
  return _postgisAvailable
}

/** Table-qualified constants used by the index-creation script. */
export const CLINIC_TSV = clinicTsv('clinics')
export const CLINIC_GEOG = clinicGeog('clinics')

/** Meters per mile (search radius is expressed in miles). */
export const METERS_PER_MILE = 1609.344

/**
 * The searchable words of free text, the way to_tsvector stores a clinic name
 * (2026-09-29): letters and digits of any script, and dots INSIDE a word.
 *
 * Until then every character outside a-z and 0-9 was replaced with a space, so
 * "Éternité" became "ternit" and "SKŸNN" became "sk nn", and neither could ever
 * match the stored 'éternité' / 'skÿnn'. "M.D." became "m" and "d", but
 * to_tsvector keeps it as one lexeme, 'm.d', so a typed clinic name carrying
 * a credential found nothing. Plain a-z/0-9 text splits exactly as before.
 * Dots are kept only in abbreviations whose parts are all one to three letters
 * (m.d, d.d.s, ph.d); "st.louis" still splits into "st" and "louis" as it did.
 * Only letters, digits and dots survive, so nothing here can be tsquery syntax.
 */
export function queryWords(input: string): string[] {
  return (input || '')
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}.]+/u)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .flatMap((t) => (!t.includes('.') || /^(\p{L}{1,3}\.)+\p{L}{1,3}$/u.test(t) ? [t] : t.split('.')))
    .filter((t) => t.length > 0)
}

/**
 * Build a prefix tsquery string from free-text input, for partial-word matching.
 * "lena park" -> "lena:* & park:*". We construct it from sanitized tokens rather
 * than passing user text to to_tsquery() (which throws on malformed syntax).
 * Returns '' when there is nothing searchable.
 *
 * `nameOnly` restricts every word to weight A, which clinicTsv gives the clinic
 * name alone: "spa:*A" matches a clinic NAMED spa-something, not one whose
 * tagline or street says spa.
 */
export function toPrefixTsQuery(input: string, opts: { nameOnly?: boolean } = {}): string {
  const tokens = queryWords(input)
  if (tokens.length === 0) return ''
  const suffix = opts.nameOnly ? ':*A' : ':*'
  // A word typed WITH accents also matches the same word stored without them
  // ("café" finds "Cafe"), which the old a-z-only split did by accident.
  // Plain a-z words produce exactly the query they always did.
  return tokens
    .map((t) => {
      const plain = t.normalize('NFD').replace(/\p{M}+/gu, '')
      return plain && plain !== t ? `(${t}${suffix} | ${plain}${suffix})` : `${t}${suffix}`
    })
    .join(' & ')
}
