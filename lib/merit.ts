/**
 * Merit ranking v1 — deterministic, explainable, tunable.
 *
 * Adjust MERIT_WEIGHTS and re-deploy to change ranking behaviour.
 * Nothing here makes a DB call; all computation is pure.
 *
 * Score formula (all sub-scores normalised to [0, 1] before weighting):
 *   rating       × w.rating
 *   reviewCount  × w.reviewCount
 *   completeness × w.completeness
 *   recency      × w.recency
 *   responseRate × w.responseRate
 *   minus penalties for unverified license or missing photo
 */
import type { DirectoryProvider, DirectoryClinic } from './location-queries'

// ─── Tunable weights ─────────────────────────────────────────────────────────
// Sensible v1 defaults. The founder can adjust these numbers without touching
// any other code; the sort will automatically reflect the new weights on the
// next ISR revalidation.

export const MERIT_WEIGHTS = {
  /**
   * Patient aggregate rating (0–5, normalised to 0–1).
   * Highest-weight signal: a 5-star provider beats a 2-star provider by 2.0 pts.
   */
  rating: 2.0,

  /**
   * log10(reviewCount + 1) normalised by log10(MAX_REVIEWS + 1).
   * Diminishing returns: 1 review → ~0.08, 10 reviews → ~0.35, 100 → 0.67, 1000 → 1.0.
   * Prevents a single 5-star review from outranking 500 good reviews.
   */
  reviewCount: 1.5,

  /**
   * Fraction of key profile fields populated (photo, bio, startingPrice,
   * treatments listed, languages listed). Max 1.0.
   * Incentivises providers to complete their profile after claiming.
   */
  completeness: 1.0,

  /**
   * Recency: scraped/updated in the last 90 days scores 1.0, fades to 0 at
   * 2 years. Placeholder 0 when updatedAt is unavailable.
   */
  recency: 0.5,

  /**
   * Booking response rate [0–1]. Placeholder 0 until we track bookings.
   */
  responseRate: 0.3,

  penalties: {
    /**
     * Deducted when licenseStateCode or licenseNumber is blank
     * (i.e., the profile has not been verified against the state board).
     */
    unverifiedLicense: 1.5,

    /**
     * Deducted when profilePhotoUrl is blank.
     * A profile without a photo converts poorly and signals an incomplete record.
     */
    noPhoto: 0.5,
  },
} as const

// ─── Internal constants ───────────────────────────────────────────────────────

/** Review counts above this saturate the log score at 1.0. */
const MAX_REVIEWS = 1000

/** Days considered "freshly verified" — recency score = 1.0. */
const RECENCY_FRESH_DAYS = 90

/** Days after which the recency score drops to 0. */
const RECENCY_STALE_DAYS = 730

/**
 * Width of a distance band, in miles, for the IP-located default listing
 * (2026-08-15).
 *
 * The founder's rule: lead with clinics near the visitor, and let merit decide
 * between clinics that are equally near. Sorting on raw distance would rank a
 * mediocre clinic 0.4 miles away above an excellent one 0.9 miles away, which
 * is not what "near me" means at city scale, where both are the same trip. So
 * distance is rounded down into 5-mile bands and merit orders each band.
 *
 * It lives in this module, and not in the SQL layer that also needs it, because
 * this module is pure and safe to pull into a client bundle; the query builder
 * is not. Both sides must use the same number or the bands the server sorted
 * into and the bands the browser re-sorts within would disagree.
 */
export const NEAR_BUCKET_MILES = 5

/**
 * Radii tried in order for the ZIP-located listing, widest last (2026-09-19,
 * founder call D1).
 *
 * 10 miles alone leaves a large share of the country looking at an empty page:
 * of 400 random ZIP centroids measured against 57,592 published clinics, 147
 * (37%) have nothing within 10 miles, 62 (16%) have nothing within 25, and 19
 * (5%) have nothing within 50. The listing retries at the next rung only when
 * the previous one returned zero rows, so a Houston visitor still pays exactly
 * one request. Every value here must also exist in RADIUS_OPTIONS in
 * ListingFilters.tsx, so the left-hand control and this default agree by
 * construction. See docs/LISTING-FIX-PLAN-2026-09-19.md TASK 2.
 *
 * 3 miles first (2026-09-28, founder call), with the visitor's own ZIP ahead
 * of it: clinics IN the ZIP lead the list, then the rest within 3 miles,
 * nearest first. Measured the same way on 400 random ZIP centroids: 22% have a
 * clinic inside the ZIP, 38% within 3 miles, 56% within 10, 86% within 25, 95%
 * within 50. An empty rung no longer costs one request per rung: the listing
 * API answers an empty result with the first wider rung that has clinics
 * (`widerRadius`), so the list jumps straight there.
 */
export const NEAR_ME_RADIUS_LADDER = [3, 10, 25, 50] as const

/**
 * How far from the ZIP centre a clinic that is IN the visitor's ZIP is still
 * looked for. The ZIP half of the near-me filter is bounded by this box so it
 * can use the latitude index like the radius half: unbounded, "OR zip = X"
 * scanned the whole table (1.3 to 1.9 s against 9 to 29 ms, staging
 * 2026-09-28). 99.8% of clinics sit within 25 miles of their own ZIP centre;
 * the 130 that do not are almost all bad coordinates.
 */
export const NEAR_ME_ZIP_REACH_MILES = 25

/**
 * Radius, in miles, for the ZIP-located default listing on the three pillar
 * pages (2026-09-10, founder call; 10 miles until 2026-09-28, now 3). See
 * docs/ZIP-NEAR-ME-LISTING-2026-09-10.md
 *
 * Not the ZIP alone: a single ZIP holds a median of 4 published clinics and
 * ~33,000 of 41,488 US ZIPs hold none, so an exact-ZIP listing would be empty
 * for most visitors. The ZIP's clinics lead, and the radius fills the page.
 *
 * Every rung is also one of RADIUS_OPTIONS in ListingFilters, so this default
 * and the left-hand radius control agree by construction. Keep it that way.
 *
 * The first rung of the ladder above. Kept as a named export because CLAUDE.md
 * and docs/ZIP-NEAR-ME-LISTING-2026-09-10.md both refer to the near-me radius
 * by this name. Derived rather than repeated so the two can never disagree.
 */
export const NEAR_ME_RADIUS_MILES = NEAR_ME_RADIUS_LADDER[0]

// ─── Extended provider shape ─────────────────────────────────────────────────
// DirectoryProvider has most fields we need. bio and updatedAt are optional
// additions supplied by mapProvider; they gracefully degrade to 0 if absent.

export type MeritProvider = DirectoryProvider & {
  /** Provider bio text (used in completeness score). */
  bio?: string
  /** ISO date string from Payload's updatedAt (used in recency score). */
  updatedAt?: string
}

// ─── Sub-scorers (all return a value in [0, 1]) ───────────────────────────────

function scoreRating(p: MeritProvider): number {
  if (!p.aggregateRating) return 0
  return Math.min(p.aggregateRating, 5) / 5
}

function scoreReviewCount(p: MeritProvider): number {
  const n = p.aggregateRatingCount ?? 0
  return Math.log10(n + 1) / Math.log10(MAX_REVIEWS + 1)
}

function scoreCompleteness(p: MeritProvider): number {
  const checks = [
    !!p.profilePhotoUrl,
    typeof p.bio === 'string' && p.bio.trim().length > 0,
    !!p.startingPrice && p.startingPrice > 0,
    Array.isArray(p.treatments) && p.treatments.length > 0,
    Array.isArray(p.languages) && p.languages.length > 0,
  ]
  return checks.filter(Boolean).length / checks.length
}

function scoreRecency(p: MeritProvider): number {
  if (!p.updatedAt) return 0
  const ageMs = Date.now() - new Date(p.updatedAt).getTime()
  const ageDays = ageMs / (1_000 * 60 * 60 * 24)
  if (ageDays <= RECENCY_FRESH_DAYS) return 1
  if (ageDays >= RECENCY_STALE_DAYS) return 0
  return 1 - (ageDays - RECENCY_FRESH_DAYS) / (RECENCY_STALE_DAYS - RECENCY_FRESH_DAYS)
}

function scoreResponseRate(_p: MeritProvider): number {
  // PLACEHOLDER — always returns 0 until booking-response tracking is implemented.
  // WARNING: when this is wired up, activating it will re-sort ALL provider rankings.
  // Test ranking impact in staging before enabling in production.
  return 0
}

// ─── Main exports ─────────────────────────────────────────────────────────────

/**
 * Returns a merit score >= 0. Higher is better.
 * Pure and deterministic: calling twice with the same input returns the same result.
 */
export function computeMeritScore(p: MeritProvider): number {
  const w = MERIT_WEIGHTS
  let score = 0
  score += scoreRating(p) * w.rating
  score += scoreReviewCount(p) * w.reviewCount
  score += scoreCompleteness(p) * w.completeness
  score += scoreRecency(p) * w.recency
  score += scoreResponseRate(p) * w.responseRate

  // Penalties (subtracted, never below 0)
  const licenseOk = !!p.licenseStateCode && !!p.licenseNumber
  if (!licenseOk) score -= w.penalties.unverifiedLicense
  if (!p.profilePhotoUrl) score -= w.penalties.noPhoto

  return Math.max(score, 0)
}

/** Sort comparator: higher merit score first. */
export function byMeritDesc(a: MeritProvider, b: MeritProvider): number {
  return computeMeritScore(b) - computeMeritScore(a)
}

/**
 * The fields the clinic merit proxy actually reads. Declared separately so the
 * sorts below work on any clinic-shaped row, not just DirectoryClinic: the
 * /clinics listing carries ClinicListItem, which has the same rating and
 * distance fields plus a few of its own.
 */
export type MeritClinicLike = {
  aggregateRating?: number
  aggregateRatingCount?: number
  photoUrl?: string
  startingPrice?: number
  distanceMiles?: number
  /** In the visitor's own ZIP, on a near-me listing. Such clinics lead. */
  inZip?: boolean
}

/** The merit proxy used for clinics: rating → review count → completeness. */
function clinicMeritScore(c: MeritClinicLike): number {
  return (
    (c.aggregateRating ?? 0) * 2 +
    Math.log10((c.aggregateRatingCount ?? 0) + 1) +
    (c.photoUrl ? 0.5 : 0) +
    (c.startingPrice ? 0.5 : 0)
  )
}

/** Sort clinics by a simple merit proxy: rating → review count → completeness. */
export function sortClinicsByMerit<T extends MeritClinicLike>(clinics: T[]): T[] {
  return [...clinics].sort((a, b) => clinicMeritScore(b) - clinicMeritScore(a))
}

/**
 * Merit order INSIDE each distance band, bands in order (2026-08-15).
 *
 * Used by the IP-located default listing. The server has already assigned every
 * clinic a 5-mile band and returned them band-first; this keeps those bands
 * intact and only reorders within them. Sorting the loaded page by merit alone
 * would throw the server's distance work away, which is the bug this exists to
 * prevent.
 *
 * A clinic with no distance (outside the near cutoff, or missing coordinates)
 * gets the far band, so the whole "we could not locate this one" group stays
 * together at the end in plain merit order.
 */
export function sortClinicsByMeritWithinBuckets<T extends MeritClinicLike>(
  clinics: T[],
  bucketMiles: number = NEAR_BUCKET_MILES,
): T[] {
  const band = (c: MeritClinicLike): number =>
    typeof c.distanceMiles === 'number' && Number.isFinite(c.distanceMiles)
      ? Math.floor(c.distanceMiles / bucketMiles)
      : Number.MAX_SAFE_INTEGER

  return [...clinics].sort((a, b) => {
    const bandDiff = band(a) - band(b)
    if (bandDiff !== 0) return bandDiff
    return clinicMeritScore(b) - clinicMeritScore(a)
  })
}

/**
 * Nearest first, for a listing already bounded to a radius (2026-09-11,
 * founder call).
 *
 * Distance bands are the wrong tool once the set is local. At 5 miles every
 * Houston clinic on page 1 shared one band and review count alone set the
 * order (nearest clinic 12th). At 1 mile the order was right by band but the
 * distance printed on each card read 1.6, 2.0, 1.8, 1.7, 1.5, 1.0 down the
 * page, which a visitor reads as a broken sort. With the distance on every
 * card, the list has to read in the order the cards say.
 *
 * Merit only separates clinics at exactly the same distance. A clinic with no
 * distance sorts last, in merit order.
 *
 * The SQL orders by the same distance when a radius is set, so page 2 carries
 * on from page 1 and this only settles the rows already loaded.
 */
export function sortClinicsByDistance<T extends MeritClinicLike>(clinics: T[]): T[] {
  const miles = (c: MeritClinicLike): number =>
    typeof c.distanceMiles === 'number' && Number.isFinite(c.distanceMiles)
      ? c.distanceMiles
      : Number.POSITIVE_INFINITY

  return [...clinics].sort((a, b) => {
    // The visitor's own ZIP first (2026-09-28), exactly as the SQL orders it.
    // Only near-me rows ever carry inZip, so every other list is unchanged.
    if (Boolean(a.inZip) !== Boolean(b.inZip)) return a.inZip ? -1 : 1
    const da = miles(a)
    const db = miles(b)
    // Compared, not subtracted: Infinity - Infinity is NaN, which sort()
    // treats as "equal" and would skip the merit tiebreak for unlocated rows.
    if (da !== db) return da < db ? -1 : 1
    return clinicMeritScore(b) - clinicMeritScore(a)
  })
}
