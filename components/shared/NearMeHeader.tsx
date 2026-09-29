'use client'

import { useState } from 'react'
import { NEAR_ME_RADIUS_LADDER } from '@/lib/merit'
import type { NearMeState } from './useNearMe'

/** "1 mile", "3 miles": the Distance control has offered 1 mile since 2026-09-29. */
const milesText = (miles: number | null | undefined) => `${miles} ${miles === 1 ? 'mile' : 'miles'}`

/**
 * Heading + count + ZIP changer for the three pillar listings (2026-09-10).
 *
 * Located: `Top Clinics in 77009, Houston, TX`, with the count for that radius
 * and, since 2026-09-28, how many of them are in the visitor's own ZIP (or a
 * plain note that the ZIP has none and how far the list reaches instead).
 * Not located: today's heading, unchanged, plus a "Set your ZIP" control --
 * required, because a visitor whose IP gave nothing (outside the US, VPN, geo
 * over budget) otherwise has no way to reach a local list at all.
 *
 * This renders INSIDE the listing section, on the page canvas, never inside the
 * navy /clinics hero -- so `text-ink-*` is correct here and the always-dark
 * band rule in CLAUDE.md is satisfied by construction rather than by a variant.
 *
 * The page <h1>, the JSON-LD, <title> and the canonical tag are untouched. The
 * server renders `fallbackHeading`; the located heading only ever replaces it
 * after hydration.
 */
export function NearMeHeader({
  near,
  enabled,
  total,
  fallbackHeading,
  radiusMiles,
  ladderExhausted,
  zipCount,
}: {
  near: NearMeState
  /** False on state and city pages: the visitor already chose a place there. */
  enabled: boolean
  /** Server total for the current query, so the number matches the list. */
  total?: number
  /** The heading this listing shows when no ZIP is in play. `{count}` and `{s}`
   *  are filled from the live server total. */
  fallbackHeading?: string
  /**
   * The radius actually applied, from useNearMeRadius. Null means every rung of
   * the ladder came back empty and the listing has fallen back to national.
   */
  radiusMiles?: number | null
  /**
   * True only when every rung of the ladder came back empty. Without it, a
   * visitor who picked "Any distance" themselves would be told there is nothing
   * within 50 miles of them, which is a different thing and not true.
   */
  ladderExhausted?: boolean
  /**
   * How many of `total` are in the visitor's own ZIP, from the listing API
   * (2026-09-28). Null or undefined when the listing did not send a ZIP, in
   * which case the plain "within N miles" line is shown.
   */
  zipCount?: number | null
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const hasZip = enabled && near.status === 'ready' && Boolean(near.zip)
  const located = hasZip && radiusMiles != null
  const noneNearby = hasZip && radiusMiles == null && Boolean(ladderExhausted)
  const unlocated = enabled && near.status === 'none'

  /**
   * `{count}` becomes the live total and `{s}` becomes the plural suffix, so a
   * heading carrying a count tracks the filter instead of freezing at the
   * page's unfiltered number. A string with no tokens passes through untouched,
   * which is what the two pillar pages send.
   *
   * This replaces the FUNCTION prop that 4.4 originally specified. The three
   * pages that pass a counted heading are Server Components and the listings
   * they render are 'use client', so Next could not serialize a function and
   * all three page types returned 500 on staging. A string crosses that
   * boundary fine. See docs/LISTING-FIX-PLAN-2026-09-19.md section 4.9.
   */
  const resolvedFallback = fallbackHeading
    ? fallbackHeading
        .replace('{count}', (total ?? 0).toLocaleString())
        .replace('{s}', total === 1 ? '' : 's')
    : fallbackHeading

  // Nothing to render on a state or city listing that also has no heading of
  // its own to pass down: those pages keep exactly the markup they had.
  if (!enabled && !resolvedFallback) return null

  // "77009, Houston, TX", "77009, Houston" or "77009" -- never ", ,".
  const placeLabel = [near.zip, near.city, near.stateCode].filter(Boolean).join(', ')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setError(null)
    const ok = await near.setZip(draft)
    setSaving(false)
    if (!ok) {
      setError('We could not find that ZIP code.')
      return
    }
    setOpen(false)
    setDraft('')
  }

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        {located ? (
          <h2 className="font-serif text-h2 text-ink-primary">Top Clinics in {placeLabel}</h2>
        ) : resolvedFallback ? (
          <h2 className="font-serif text-h2 text-ink-primary">{resolvedFallback}</h2>
        ) : (
          <span />
        )}

        {enabled && (
          <button
            type="button"
            onClick={() => {
              setOpen((v) => !v)
              setError(null)
            }}
            className="text-body-sm font-medium text-brand-accent hover:underline"
          >
            {hasZip ? 'Change' : 'Set your ZIP'}
          </button>
        )}
      </div>

      {/* 2026-09-28: the visitor's ZIP leads the list. When it has no clinic
          of its own, say so, and say how far the list reaches instead. Since
          2026-09-29 also under a Distance the visitor picked themselves. */}
      {located && typeof total === 'number' && (
        <p className="mt-2 text-body-sm text-ink-secondary">
          {total === 0
            ? `No clinics within ${milesText(radiusMiles)} of ${near.zip}.`
            : typeof zipCount === 'number' && zipCount === 0
              ? `No clinics in ${near.zip}. Showing ${total.toLocaleString()} ${total === 1 ? 'clinic' : 'clinics'} within ${milesText(radiusMiles)}.`
              : typeof zipCount === 'number' && zipCount > 0
                ? `${zipCount.toLocaleString()} ${zipCount === 1 ? 'clinic' : 'clinics'} in ${near.zip}, plus nearby within ${milesText(radiusMiles)} (${total.toLocaleString()} total)`
                : `${total.toLocaleString()} ${total === 1 ? 'clinic' : 'clinics'} within ${milesText(radiusMiles)}`}
        </p>
      )}

      {/* Ladder exhausted. Founder decision D1: say so plainly rather than show
          an empty grid. Since 2026-09-29 the list is the nearest clinics,
          however far (Texas first for a Houston ZIP), not the national top. */}
      {noneNearby && (
        <p className="mt-2 text-body-sm text-ink-secondary">
          No clinics within {NEAR_ME_RADIUS_LADDER[NEAR_ME_RADIUS_LADDER.length - 1]} miles of{' '}
          {placeLabel}. Showing the nearest clinics instead.
        </p>
      )}

      {/* Founder decision D2. Also covers a VPN, a blocked request and a geo
          timeout, and the sentence is true in every one of those cases. Never
          in the served HTML: status is 'idle' on the server. */}
      {unlocated && (
        <p className="mt-2 text-body-sm text-ink-secondary">
          We could not detect a US location. Enter a ZIP to see clinics near you.
        </p>
      )}

      {enabled && open && (
        <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="near-me-zip" className="sr-only">
            ZIP code
          </label>
          <input
            id="near-me-zip"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 5))}
            inputMode="numeric"
            autoComplete="postal-code"
            placeholder="ZIP code"
            className="w-32 rounded-control border border-border bg-surface-canvas px-3 py-2 text-body-sm text-ink-primary"
          />
          <button
            type="submit"
            disabled={draft.length !== 5 || saving}
            className="rounded-control bg-brand-primary px-4 py-2 text-body-sm font-semibold text-surface-canvas hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Checking...' : 'Apply'}
          </button>
          {hasZip && (
            <button
              type="button"
              onClick={() => {
                near.clear()
                setOpen(false)
                setDraft('')
                setError(null)
              }}
              className="text-body-sm text-ink-secondary hover:text-ink-primary"
            >
              Clear
            </button>
          )}
          {error && (
            <p className="w-full text-body-sm text-state-error" role="status">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  )
}
