/**
 * Server-side search intent parser (Phase 13).
 *
 * Turns a single free-text omnibox query into structured intent:
 *   - treatment  (matched against the Treatments list + the import alias map)
 *   - location   (matched against state names/codes + known city/neighborhood names)
 *   - zip        (a 5-digit US ZIP)
 *   - freeText   (whatever is left -> provider / clinic name full-text)
 *
 * This is the PRIMARY mechanism for "type anything": each matched part is applied
 * as the corresponding filter in searchDirectory. It is a pure function given the
 * lookup tables (which searchDirectory builds from the DB), so it is trivially
 * testable and does no IO itself.
 *
 * Matching is greedy and phrase-aware (longest n-gram wins) so "lip filler new
 * york" splits into treatment="lip-filler" + location="new york", and a bare
 * provider name like "lena park" stays as freeText.
 */
import { treatmentSlugFor } from './import/helpers'
import { BRAND_SYNONYMS, NEAR_ME_PHRASES, QUERY_NOISE, SERVICE_SYNONYMS } from './search-synonyms'

export type ParsedIntent = {
  treatmentSlug?: string
  /** Product brand slug (e.g. "juvederm"), when the query named one. */
  brandSlug?: string
  /** Raw location phrase to feed the existing location resolver (state/city). */
  location?: string
  /** 5-digit ZIP, if one was present. */
  zip?: string
  /** Leftover tokens -> provider/clinic name full-text. */
  freeText: string
  /** A "near me" phrase was present (and consumed). */
  nearMe?: boolean
  /**
   * True when anything beyond the exact dictionary match shaped this parse: a
   * spelling-tolerant treatment/brand match, a dropped noise word, or "near me".
   * searchDirectory re-runs such a query with `exactOnly` when it finds
   * nothing, so the tolerance can only ever add results, never lose a search
   * that worked before (e.g. a clinic whose NAME contains "Lip Fillers").
   */
  tolerant?: boolean
}

export type IntentLookups = {
  /** Lowercased treatment phrase (name / alias / slug-as-words) -> canonical slug. */
  treatmentPhraseToSlug: Map<string, string>
  /** Lowercased brand phrase (name / slug-as-words) -> canonical slug. */
  brandPhraseToSlug: Map<string, string>
  /** Lowercased known location phrases (state names, state codes, cities, neighborhoods). */
  locationPhrases: Set<string>
  /** Spelling-tolerant keys. Absent means exact matching only (the old behaviour). */
  tolerant?: TolerantLookups
}

export type ParseOptions = {
  /** Exact dictionary matching only: exactly how the parser behaved before 2026-09-28. */
  exactOnly?: boolean
}

// ── Spelling tolerance (2026-09-28) ──────────────────────────────────────────
//
// The exact dictionary only knew "lip filler", "lip-filler" and "lips", so
// "lipfiller", "lip fillers", "lip filer" and "lip injections" all fell through
// to the clinic-NAME search and came back with 0 or 1 unrelated clinic
// (measured on staging). The same held for every service and brand.
//
// Tolerant matching runs only after the exact pass found nothing for that
// category, in this order, and stops at the first hit:
//   1. compact: spaces, hyphens, underscores and punctuation ignored
//      ("lipfiller" = "lip_filler" = "lip filler"), synonyms included;
//   2. the same with a trailing plural removed ("lip fillers");
//   3. one or two typos, when exactly one treatment/brand is that close.
// A window of words that is itself a known place is never matched, so a city
// can not be read as a treatment.

/** Lowercase, accents removed, everything except a-z and 0-9 dropped. */
export function compactKey(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/** "fillers" -> "filler", "therapies" -> "therapy". Leaves "botox", "glass", "lips"->"lip". */
export function singularToken(t: string): string {
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y'
  if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) return t.slice(0, -1)
  return t
}

export type TolerantLookups = {
  treatmentCompact: Map<string, string>
  brandCompact: Map<string, string>
  treatmentFuzzy: [key: string, slug: string][]
  brandFuzzy: [key: string, slug: string][]
}

/** Shortest compact key a typo may be matched against: "prp", "lips", "peel" stay exact-only. */
const FUZZY_MIN_KEY = 5
/** Shortest query window (compact) that may be typo-matched. "botx" is 4. */
const FUZZY_MIN_QUERY = 4

function maxTypos(len: number): number {
  if (len < FUZZY_MIN_QUERY) return 0
  return len >= 8 ? 2 : 1
}

/**
 * Optimal string alignment distance (Levenshtein plus adjacent transposition,
 * so "dysprot" -> "dysport" is 1). Returns max + 1 as soon as the answer is
 * known to exceed `max`.
 */
function typoDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const prev2: number[] = new Array(b.length + 1).fill(0)
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = new Array(b.length + 1).fill(0)
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1)
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j]
    prev = cur
  }
  return prev[b.length]
}

function addCompact(map: Map<string, string>, blocked: Set<string>, phrase: string, slug: string) {
  const key = compactKey(phrase)
  if (!key || blocked.has(key)) return
  const existing = map.get(key)
  if (existing && existing !== slug) {
    // Two different targets share a spelling: neither may claim it.
    map.delete(key)
    blocked.add(key)
    return
  }
  map.set(key, slug)
}

/**
 * Build the tolerant keys from the SAME exact dictionaries the parser already
 * uses (names, slugs, importer aliases), plus the search-only synonyms whose
 * target exists in this database.
 */
export function buildTolerantLookups(opts: {
  treatmentPhraseToSlug: Map<string, string>
  brandPhraseToSlug: Map<string, string>
  serviceSlugs: Set<string>
  brandSlugs: Set<string>
}): TolerantLookups {
  const treatmentCompact = new Map<string, string>()
  const brandCompact = new Map<string, string>()
  const tBlocked = new Set<string>()
  const bBlocked = new Set<string>()
  for (const [phrase, slug] of opts.treatmentPhraseToSlug) addCompact(treatmentCompact, tBlocked, phrase, slug)
  for (const [phrase, slug] of Object.entries(SERVICE_SYNONYMS)) {
    if (opts.serviceSlugs.has(slug)) addCompact(treatmentCompact, tBlocked, phrase, slug)
  }
  for (const [phrase, slug] of opts.brandPhraseToSlug) addCompact(brandCompact, bBlocked, phrase, slug)
  for (const [phrase, slug] of Object.entries(BRAND_SYNONYMS)) {
    if (opts.brandSlugs.has(slug)) addCompact(brandCompact, bBlocked, phrase, slug)
  }
  const fuzzy = (m: Map<string, string>) =>
    [...m.entries()].filter(([k]) => k.length >= FUZZY_MIN_KEY && !/^\d+$/.test(k))
  return {
    treatmentCompact,
    brandCompact,
    treatmentFuzzy: fuzzy(treatmentCompact),
    brandFuzzy: fuzzy(brandCompact),
  }
}

/** The single slug within the typo budget of `key`, or undefined when none or more than one is. */
function uniqueFuzzy(key: string, candidates: [string, string][]): string | undefined {
  const max = maxTypos(key.length)
  if (max === 0 || /^\d+$/.test(key)) return undefined
  let best = max + 1
  let slugs = new Set<string>()
  for (const [k, slug] of candidates) {
    const d = typoDistance(key, k, Math.min(max, best))
    if (d < best) {
      best = d
      slugs = new Set([slug])
    } else if (d === best && d <= max) {
      slugs.add(slug)
    }
  }
  return best <= max && slugs.size === 1 ? [...slugs][0] : undefined
}

/**
 * Resolve a whole phrase (not a query) tolerantly: compact, plural, typo.
 * Used by the autocomplete and by the explicit `treatment` url param.
 */
export function resolveTolerant(
  text: string,
  t: TolerantLookups,
  kind: 'treatment' | 'brand',
): string | undefined {
  const compact = kind === 'treatment' ? t.treatmentCompact : t.brandCompact
  const fuzzy = kind === 'treatment' ? t.treatmentFuzzy : t.brandFuzzy
  const words = normalize(text).split(/[\s,]+/).filter(Boolean)
  const raw = compactKey(words.join(' '))
  const folded = compactKey(words.map(singularToken).join(' '))
  return compact.get(raw) ?? compact.get(folded) ?? uniqueFuzzy(folded, fuzzy)
}

/**
 * Tolerant counterpart of findFirstPhrase: same windows (left to right,
 * longest first, unconsumed tokens only), three passes. Windows that are a
 * known place, or made only of noise words, are never matched.
 */
function findTolerantPhrase(
  tokens: string[],
  consumed: boolean[],
  compact: Map<string, string>,
  fuzzy: [string, string][],
  locationPhrases: Set<string>,
): { slug: string; start: number; len: number } | null {
  const windows: { start: number; len: number; raw: string; folded: string }[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue
    const maxLen = Math.min(MAX_PHRASE_WORDS, tokens.length - i)
    for (let len = maxLen; len >= 1; len--) {
      let ok = true
      for (let k = 0; k < len; k++) if (consumed[i + k]) { ok = false; break }
      if (!ok) continue
      const words = tokens.slice(i, i + len)
      if (locationPhrases.has(words.join(' '))) continue
      if (words.every((w) => QUERY_NOISE.has(w) || NAME_NOISE.has(w))) continue
      windows.push({
        start: i,
        len,
        raw: compactKey(words.join(' ')),
        folded: compactKey(words.map(singularToken).join(' ')),
      })
    }
  }
  for (const w of windows) {
    const slug = compact.get(w.raw) ?? compact.get(w.folded)
    if (slug) return { slug, start: w.start, len: w.len }
  }
  for (const w of windows) {
    const slug = uniqueFuzzy(w.folded, fuzzy)
    if (slug) return { slug, start: w.start, len: w.len }
  }
  return null
}

const MAX_PHRASE_WORDS = 3

// Honorifics + credential suffixes are noise in a NAME query (they live in the
// providers.credentials column, not in the searched name tsvector). Stripping them
// keeps "Jenna Wu, PA" / "Dr. Lena Park MD" matching the stored full name. "pa",
// "do", etc. would also collide with state codes / English words, which is the
// other reason 2-letter state codes are kept OUT of the location lookup.
export const NAME_NOISE = new Set([
  'dr', 'dr.', 'doctor', 'md', 'do', 'np', 'pa', 'rn', 'dds', 'dmd', 'facs', 'faad',
])

function normalize(raw: string): string {
  return (raw || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Build the brand lookup from the live Brands rows (e.g. "juvederm" -> "juvederm",
 * "rha collection" -> "rha-collection"). Brands are product names (Juvederm,
 * Restylane, Sculptra...) which are distinct from treatments (lip-filler,
 * masseter-botox...); a query like "juvederm" must resolve here, not as freeText.
 */
export function buildBrandLookup(brands: { name: string; slug: string }[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const b of brands) {
    map.set(b.name.toLowerCase(), b.slug)
    map.set(b.slug.replace(/-/g, ' '), b.slug)
    map.set(b.slug, b.slug)
  }
  return map
}

/**
 * Build the treatment lookup from the live Treatments rows plus the shared import
 * alias map (reused so the omnibox understands the same shorthands the importer
 * does, e.g. "lips" -> lip-filler, "under eye" -> tear-trough).
 */
export function buildServiceLookup(
  treatments: { name: string; slug: string }[],
): Map<string, string> {
  const map = new Map<string, string>()
  const validSlugs = new Set(treatments.map((t) => t.slug))
  for (const t of treatments) {
    const slug = t.slug
    map.set(t.name.toLowerCase(), slug)
    map.set(slug.replace(/-/g, ' '), slug)
    map.set(slug, slug)
  }
  // Layer the import alias map on top, but only for aliases that resolve to a real
  // treatment slug in this DB (so we never offer a treatment that does not exist).
  // treatmentSlugFor returns the alias map's slug or a kebab of the label.
  for (const phrase of ALIAS_PHRASES) {
    const slug = treatmentSlugFor(phrase)
    if (slug && validSlugs.has(slug)) map.set(phrase, slug)
  }
  return map
}

// The alias phrases the importer recognizes. Kept here as the set of human labels
// to test; treatmentSlugFor() owns the actual phrase->slug mapping.
const ALIAS_PHRASES = [
  'botox', 'dysport', 'xeomin', 'jeuveau', 'daxxify',
  'lip filler', 'lips', 'cheek filler', 'cheeks', 'jawline filler', 'jawline',
  'tear trough', 'tear trough filler', 'under eye', 'masseter', 'masseter botox',
  'kybella', 'sculptra', 'prp', 'prp therapy', 'microneedling', 'thread lift',
]

/** Find the first phrase (longest n-gram, left to right) present in `lookup`. */
function findFirstPhrase(
  tokens: string[],
  consumed: boolean[],
  has: (phrase: string) => boolean,
): { phrase: string; start: number; len: number } | null {
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue
    const maxLen = Math.min(MAX_PHRASE_WORDS, tokens.length - i)
    for (let len = maxLen; len >= 1; len--) {
      // phrase must be over contiguous, unconsumed tokens
      let ok = true
      for (let k = 0; k < len; k++) if (consumed[i + k]) { ok = false; break }
      if (!ok) continue
      const phrase = tokens.slice(i, i + len).join(' ')
      if (has(phrase)) return { phrase, start: i, len }
    }
  }
  return null
}

export function parseSearchQuery(raw: string, lk: IntentLookups, opts: ParseOptions = {}): ParsedIntent {
  const norm = normalize(raw)
  if (!norm) return { freeText: '' }
  const tolerantLk = opts.exactOnly ? undefined : lk.tolerant
  let tolerant = false

  // 1) ZIP: pull the first standalone 5-digit group out.
  let zip: string | undefined
  const zipMatch = norm.match(/(?:^|\s)(\d{5})(?=$|\s)/)
  let working = norm
  if (zipMatch) {
    zip = zipMatch[1]
    working = (norm.slice(0, zipMatch.index) + ' ' + norm.slice((zipMatch.index ?? 0) + zipMatch[0].length)).trim()
  }

  // Tokens made only of punctuation ("lip - filler") carry nothing: they used
  // to sit between two words and stop them matching as one phrase, then end
  // up as free text that toPrefixTsQuery threw away anyway.
  const tokens = working.split(/[\s,]+/).filter((t) => /[\p{L}\p{N}]/u.test(t))
  const consumed = new Array(tokens.length).fill(false)
  const consume = (hit: { start: number; len: number }) => {
    for (let k = 0; k < hit.len; k++) consumed[hit.start + k] = true
  }

  // 2) Treatment: first phrase that maps to a treatment slug.
  let treatmentSlug: string | undefined
  const tHit = findFirstPhrase(tokens, consumed, (p) => lk.treatmentPhraseToSlug.has(p))
  if (tHit) {
    treatmentSlug = lk.treatmentPhraseToSlug.get(tHit.phrase)
    consume(tHit)
  }

  // 3) Brand: first phrase that maps to a product brand slug (e.g. "juvederm").
  let brandSlug: string | undefined
  const bHit = findFirstPhrase(tokens, consumed, (p) => lk.brandPhraseToSlug.has(p))
  if (bHit) {
    brandSlug = lk.brandPhraseToSlug.get(bHit.phrase)
    consume(bHit)
  }

  // 3a) A brand whose name swallows the treatment the exact pass just took:
  // "hydra facial" is HydraFacial, not the Facial service plus the name text
  // "hydra" (2 results on staging, 2026-09-28). Only a compact brand match over
  // a strictly longer window that contains the whole treatment window counts.
  if (tolerantLk && tHit && !brandSlug) {
    for (let start = Math.max(0, tHit.start - (MAX_PHRASE_WORDS - 1)); start <= tHit.start && !brandSlug; start++) {
      for (let len = MAX_PHRASE_WORDS; len > tHit.len; len--) {
        const end = start + len
        if (end < tHit.start + tHit.len || end > tokens.length) continue
        let free = true
        for (let k = start; k < end; k++) {
          if (consumed[k] && (k < tHit.start || k >= tHit.start + tHit.len)) { free = false; break }
        }
        if (!free) continue
        const slug = tolerantLk.brandCompact.get(compactKey(tokens.slice(start, end).join(' ')))
        if (slug) {
          for (let k = tHit.start; k < tHit.start + tHit.len; k++) consumed[k] = false
          treatmentSlug = undefined
          brandSlug = slug
          consume({ start, len })
          tolerant = true
          break
        }
      }
    }
  }

  // 3b) Spelling-tolerant treatment / brand, only for a category the exact
  // pass left empty, and before the location pass so a typo cannot be read
  // as a place ("filer" is a town in Idaho).
  if (tolerantLk) {
    if (!treatmentSlug) {
      const hit = findTolerantPhrase(tokens, consumed, tolerantLk.treatmentCompact, tolerantLk.treatmentFuzzy, lk.locationPhrases)
      if (hit) {
        treatmentSlug = hit.slug
        consume(hit)
        tolerant = true
      }
    }
    if (!brandSlug) {
      const hit = findTolerantPhrase(tokens, consumed, tolerantLk.brandCompact, tolerantLk.brandFuzzy, lk.locationPhrases)
      if (hit) {
        brandSlug = hit.slug
        consume(hit)
        tolerant = true
      }
    }
  }

  // 3c) "near me": consumed here so it never reaches the location or name
  // passes. The caller decides whether it can locate the visitor.
  let nearMe = false
  if (tolerantLk) {
    for (const phrase of NEAR_ME_PHRASES) {
      for (let i = 0; i + phrase.length <= tokens.length; i++) {
        let match = true
        for (let k = 0; k < phrase.length; k++) {
          if (consumed[i + k] || tokens[i + k] !== phrase[k]) { match = false; break }
        }
        if (match) {
          consume({ start: i, len: phrase.length })
          nearMe = true
          tolerant = true
        }
      }
    }
  }

  // 4) Location: longest known location phrase among the rest.
  let location: string | undefined
  const lHit = findFirstPhrase(tokens, consumed, (p) => lk.locationPhrases.has(p))
  if (lHit) {
    location = lHit.phrase
    consume(lHit)
  }

  // 5) Whatever is left is the free-text name query (minus honorific/credential noise).
  let leftover = tokens.filter((_, i) => !consumed[i]).filter((t) => !NAME_NOISE.has(t))

  // 5b) Words about the search itself ("best", "cost", "injections", "in")
  // are dropped, but only once the query has named something to search FOR,
  // and only when EVERY leftover word is one of them. A leftover with a real
  // word in it is a clinic name and is searched as typed: "California
  // Specialists Medical Center" must not lose "specialists" and "center" and
  // widen to 682 clinics (caught by the before/after compare, 2026-09-28).
  const isNoise = (t: string) => QUERY_NOISE.has(t) || QUERY_NOISE.has(singularToken(t))
  if (
    tolerantLk &&
    (treatmentSlug || brandSlug || location || zip || nearMe) &&
    leftover.length > 0 &&
    leftover.every(isNoise)
  ) {
    leftover = []
    tolerant = true
  }
  const freeText = leftover.join(' ').trim()

  return {
    treatmentSlug,
    brandSlug,
    location,
    zip,
    freeText,
    ...(nearMe ? { nearMe } : {}),
    ...(tolerant ? { tolerant } : {}),
  }
}
