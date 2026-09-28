import { NextRequest, NextResponse } from 'next/server'
import { getPayloadInstance } from '@/lib/payload-server'
import { RateLimiter, getIp } from '@/lib/rate-limit'
import { lookupZip, suggestZips } from '@/lib/zip-lookup'
import { getLocationSlugMap, lookupSlugs } from '@/lib/location-slug-lookup'
import type { Suggestion } from '@/lib/search-client'
import {
  buildBrandLookup,
  buildServiceLookup,
  buildTolerantLookups,
  compactKey,
  resolveTolerant,
  type TolerantLookups,
} from '@/lib/search-intent'

type SuggestType = 'all' | 'service' | 'location'

// Autocomplete for the omnibox (Phase 13). Fast, typed suggestions: services,
// locations (states + cities), and top clinics by name. Read-only.
export const dynamic = 'force-dynamic'

// Generous for debounced typing; suggest is cheaper than full search.
const limiter = new RateLimiter(120, 60 * 1000)

/**
 * Typeahead output is a pure function of `q` + `type`, with no personalization.
 * Caching at the CDN is what makes debounced typing cheap: the common prefixes
 * ("bo", "bot", "boto", "botox") are served from the edge instead of running a
 * trigram query per keystroke. See app/api/search/route.ts for the full note.
 */
const SUGGEST_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300'

// Sub-minimum queries always return the same empty payload, so they can be
// cached hard. This is the single most common request the endpoint sees.
const EMPTY_CACHE_CONTROL = 'public, s-maxage=3600, stale-while-revalidate=86400'

// ── Module-level cache for the static lists (rarely change) ──────────────────
type StaticLists = {
  services: { name: string; slug: string; category: string }[]
  brands: { name: string; slug: string }[]
  locations: { label: string; href: string; sublabel: string }[]
  /** Same spelling-tolerant keys the search itself uses (lib/search-intent.ts). */
  tolerant: TolerantLookups
}
let cache: { at: number; lists: StaticLists } | null = null
const TTL_MS = 5 * 60 * 1000

async function getStaticLists(payload: any, pool: any): Promise<StaticLists> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.lists

  const [servicesRes, brandsRes, statesRes] = await Promise.all([
    payload.find({ collection: 'services', limit: 200, depth: 0, sort: 'name' }),
    payload.find({ collection: 'brands', limit: 200, depth: 0, sort: 'name' }),
    payload.find({ collection: 'locations', where: { kind: { equals: 'state' } }, limit: 200, depth: 0 }),
  ])

  const services = (servicesRes.docs as any[]).map((t) => ({
    name: String(t.name),
    slug: String(t.slug),
    category: String(t.category ?? ''),
  }))

  const brands = (brandsRes.docs as any[]).map((b) => ({
    name: String(b.name),
    slug: String(b.slug),
  }))

  const locations: { label: string; href: string; sublabel: string }[] = []
  for (const s of statesRes.docs as any[]) {
    if (s.name && s.slug) {
      locations.push({ label: String(s.name), href: `/clinics/${s.slug}`, sublabel: 'State' })
    }
  }
  // Cities from clinic data so we only suggest places we actually have.
  try {
    const places = await pool.query(
      `SELECT city, state, count(*)::int AS n FROM clinics
       WHERE city IS NOT NULL AND state IS NOT NULL AND status = 'published'
       GROUP BY city, state ORDER BY n DESC LIMIT 300`,
    )
    for (const row of places.rows) {
      const label = `${row.city}, ${row.state}`
      locations.push({ label, href: `/search?location=${encodeURIComponent(label)}`, sublabel: 'City' })
    }
  } catch {
    /* fall back to states only */
  }

  const tolerant = buildTolerantLookups({
    treatmentPhraseToSlug: buildServiceLookup(services),
    brandPhraseToSlug: buildBrandLookup(brands),
    serviceSlugs: new Set(services.map((s) => s.slug)),
    brandSlugs: new Set(brands.map((b) => b.slug)),
  })

  cache = { at: Date.now(), lists: { services, brands, locations, tolerant } }
  return cache.lists
}

/**
 * Neutralises LIKE/ILIKE wildcards in user input. Without this a query of "50%"
 * or "a_b" is a pattern rather than text, so it matches far more than the
 * visitor typed. The patterns are built by string concatenation below, so the
 * escaping has to happen here rather than in the parameter binding.
 */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function startsOrIncludes(haystack: string, q: string): number {
  const h = haystack.toLowerCase()
  if (h.startsWith(q)) return 2
  if (h.includes(q)) return 1
  return 0
}

/**
 * startsOrIncludes, then the same test with spaces and punctuation ignored on
 * both sides, so "lipfiller" and "lip-filler" find "Lip Filler". The second
 * test only runs when the first found nothing, so no existing suggestion moves.
 */
function nameScore(name: string, q: string): number {
  const direct = startsOrIncludes(name, q)
  if (direct > 0) return direct
  const qc = compactKey(q)
  if (qc.length < 3) return 0
  const nc = compactKey(name)
  if (nc.startsWith(qc)) return 2
  if (nc.includes(qc)) return 1
  return 0
}

export async function GET(req: NextRequest) {
  if (!(await limiter.check(getIp(req)))) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  const type: SuggestType = (['service', 'location'].includes(
    req.nextUrl.searchParams.get('type') ?? '',
  )
    ? req.nextUrl.searchParams.get('type')
    : 'all') as SuggestType

  if (q.length < 2) {
    return NextResponse.json({ suggestions: [] }, { headers: { 'Cache-Control': EMPTY_CACHE_CONTROL } })
  }

  try {
    const payload = await getPayloadInstance()
    const pool = (payload.db as any).pool
    const lists = await getStaticLists(payload, pool)
    const ql = q.toLowerCase()
    const wantService = type !== 'location'
    const wantLocation = type !== 'service'

    // ZIP suggestions — real lookups against the zip_codes table (Phase 14).
    // Partial digits (2-4): prefix match returns up to 5 ZIPs.
    // Full 5 digits: resolve city/state for a richer label.
    let zipSuggestions: Suggestion[] = []
    if (wantLocation && /^\d{2,5}$/.test(ql)) {
      if (/^\d{5}$/.test(ql)) {
        const hit = await lookupZip(ql, pool)
        if (hit) {
          zipSuggestions = [
            {
              type: 'zip' as const,
              label: hit.label,
              sublabel: 'ZIP code',
              href: `/search?location=${encodeURIComponent(ql)}`,
            },
          ]
        } else {
          // ZIP not in dataset — still offer a generic search suggestion.
          zipSuggestions = [
            {
              type: 'zip' as const,
              label: ql,
              sublabel: 'ZIP code — search nearby clinics',
              href: `/search?location=${encodeURIComponent(ql)}`,
            },
          ]
        }
      } else {
        const hits = await suggestZips(ql, pool, 5)
        zipSuggestions = hits.map((h) => ({
          type: 'zip' as const,
          label: `${h.zip}, ${h.city}, ${h.state}`,
          sublabel: 'ZIP code',
          href: `/search?location=${encodeURIComponent(h.zip)}`,
        }))
      }
    }

    // Services (max 4, only for "what" field). Sublabel says "Service" to match
    // the type badge shown alongside it (TYPE_LABEL.service = 'Service' in
    // HeroSearch.tsx / HeaderSearchBar.tsx) -- they used to disagree.
    const services: Suggestion[] = wantService
      ? lists.services
          .map((t) => ({ t, score: nameScore(t.name, ql) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 4)
          .map((x) => ({
            type: 'service' as const,
            label: x.t.name,
            sublabel: 'Service',
            href: `/services/${x.t.slug}`,
          }))
      : []

    // Brands (max 3, only for "what" field). Previously missing entirely --
    // typing a brand name like "Juvederm" got no dedicated suggestion.
    const brands: Suggestion[] = wantService
      ? lists.brands
          .map((b) => ({ b, score: nameScore(b.name, ql) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((x) => ({
            type: 'brand' as const,
            label: x.b.name,
            sublabel: 'Brand',
            href: `/brands/${x.b.slug}`,
          }))
      : []

    // Nothing by name: try the search's own spelling tolerance on the whole
    // text, so "lip fillers", "lip filer", "juvaderm" or "microblading" still
    // offer the right service or brand. Only when the name tests found nothing,
    // so every suggestion that exists today is unchanged.
    if (wantService && services.length === 0 && brands.length === 0 && ql.length >= 4) {
      const svcSlug = resolveTolerant(ql, lists.tolerant, 'treatment')
      const svc = svcSlug ? lists.services.find((s) => s.slug === svcSlug) : undefined
      if (svc) services.push({ type: 'service', label: svc.name, sublabel: 'Service', href: `/services/${svc.slug}` })
      const brandSlug = resolveTolerant(ql, lists.tolerant, 'brand')
      const brand = brandSlug ? lists.brands.find((b) => b.slug === brandSlug) : undefined
      if (brand) brands.push({ type: 'brand', label: brand.name, sublabel: 'Brand', href: `/brands/${brand.slug}` })
    }

    // Locations (max 5, only for "where" field)
    const locations: Suggestion[] = wantLocation
      ? lists.locations
          .map((l) => ({ l, score: startsOrIncludes(l.label, ql) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((x) => ({
            type: 'location' as const,
            label: x.l.label,
            sublabel: x.l.sublabel,
            href: x.l.href,
          }))
      : []

    // Clinics by NAME prefix (max 4, only for the "what" field).
    //
    // Both queries tiebreak on rating_count then id (added 2026-08-17). Rating
    // alone is not a total order here: 26,419 of 39,669 published clinics carry
    // a rating and huge numbers of them sit at exactly 5.0, so "top 4 by rating"
    // was really "any 4 of the 5.0s, in whatever order the scan produced". Two
    // identical requests could answer differently, and a 5.0 backed by one
    // review outranked a 5.0 backed by 250. Same class of bug as the listing
    // pagination tiebreak fixed on 2026-08-15.
    let clinics: Suggestion[] = []
    if (wantService) {
      const escaped = likeEscape(ql)
      const starts = `${escaped}%`
      const wordStarts = `% ${escaped}%`
      // Index pre-filter. The two LIKE patterns above decide the RESULT; this one
      // only decides how fast we get there, and it is a strict superset of both
      // (anything starting with the query, or with " query" inside it, also
      // contains the query), so the rows returned are identical either way.
      //
      // Why it is needed: clinics carries clinics_name_trgm_idx (gin_trgm_ops on
      // clinic_name), but neither `lower(clinic_name) LIKE ...` nor a
      // leading-wildcard pattern can use it, so every keystroke seq-scanned all
      // 39.7k clinics / 183MB. Measured on staging 2026-08-17: 204ms per
      // keystroke that way, 1.4ms with `clinic_name ILIKE '%bot%'` in front of it
      // (bitmap index scan, ~150 candidate rows). ILIKE is the trigram-friendly
      // spelling; lower() around the column is exactly what defeats the index.
      //
      // Trigram indexes need 3 characters to match anything, so a 2-char query
      // keeps the old plan rather than silently returning nothing.
      const trigramUsable = ql.length >= 3
      const contains = `%${escaped}%`
      const clinicFilter = trigramUsable
        ? `clinic_name ILIKE $3 AND (lower(clinic_name) LIKE $1 OR lower(clinic_name) LIKE $2)`
        : `(lower(clinic_name) LIKE $1 OR lower(clinic_name) LIKE $2)`
      const clinicParams = trigramUsable ? [starts, wordStarts, contains] : [starts, wordStarts]

      const [slugMap, cRes] = await Promise.all([
        getLocationSlugMap(),
        pool.query(
          `SELECT slug, clinic_name AS name, city, state
             FROM clinics
            WHERE ${clinicFilter}
              AND status = 'published'
            ORDER BY aggregate_rating DESC NULLS LAST,
                     aggregate_rating_count DESC NULLS LAST,
                     id DESC
            LIMIT 4`,
          clinicParams,
        ),
      ])
      clinics = (cRes.rows as any[]).map((row) => {
        const s = lookupSlugs(row.city ?? '', row.state ?? '', slugMap)
        return {
          type: 'clinic' as const,
          label: row.name,
          sublabel: [row.city, row.state].filter(Boolean).join(', '),
          href: `/clinics/${s.stateSlug}/${s.citySlug}/${row.slug}`,
        }
      })
    }

    const suggestions: Suggestion[] = [
      ...zipSuggestions,
      ...services,
      ...brands,
      ...locations,
      ...clinics,
    ].slice(0, 12)

    return NextResponse.json({ suggestions }, { headers: { 'Cache-Control': SUGGEST_CACHE_CONTROL } })
  } catch (err: any) {
    console.error('[api/search/suggest] failed:', err?.message ?? err)
    // Never cache a degraded/empty result: a transient DB blip must not get
    // pinned at the edge for the next hour.
    return NextResponse.json(
      { suggestions: [] },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
