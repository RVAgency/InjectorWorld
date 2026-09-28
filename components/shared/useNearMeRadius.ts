'use client'

import { useCallback, useEffect, useState } from 'react'
import { NEAR_ME_RADIUS_LADDER } from '@/lib/merit'

/**
 * Which rung of the near-me radius ladder the listing is currently on
 * (2026-09-19, founder decision D1).
 *
 * The listing calls widen() when a radius query comes back with zero rows. That
 * changes the radius, which changes serverFilterKey, which the existing
 * page-1 refetch effect already reacts to. No parallel fetch mechanism.
 *
 * Resets whenever the ZIP changes, so a visitor who moves from a rural ZIP to a
 * city one starts at the first rung (3 miles) again.
 *
 * See docs/LISTING-FIX-PLAN-2026-09-19.md TASK 2.
 */
export function useNearMeRadius(zip: string | null, queryKey: string = '') {
  const [step, setStep] = useState(0)

  /**
   * The ladder belongs to ONE query, not to the visitor, so it resets when the
   * ZIP changes and also when the panel filters change. Without the second
   * key, a radius that climbed to 50 because a rare brand had no match nearby
   * survives the filter being cleared, and a Houston visitor is left on the
   * national list under "No clinics within 50 miles of 77009" with 307 clinics
   * inside 10 miles of them. Measured 2026-09-19: Bellafill and Thermage FLX
   * both have zero clinics within 50 miles of Houston, so this is a three
   * click path. See docs/LISTING-FIX-PLAN-2026-09-19.md section 2.9.
   */
  useEffect(() => {
    setStep(0)
  }, [zip, queryKey])

  const widen = useCallback(() => {
    setStep((s) => Math.min(s + 1, NEAR_ME_RADIUS_LADDER.length))
  }, [])

  /**
   * Jump straight to the rung the listing API named (2026-09-28): an empty
   * radius response carries `widerRadius`, the first wider rung that has
   * clinics, or null when none has. Skips the empty rungs in between instead
   * of fetching each one. Anything unexpected falls back to one step.
   */
  const widenTo = useCallback((target: number | null | undefined) => {
    if (target === null) {
      setStep(NEAR_ME_RADIUS_LADDER.length)
      return
    }
    const index = typeof target === 'number' ? (NEAR_ME_RADIUS_LADDER as readonly number[]).indexOf(target) : -1
    setStep((s) => (index > s ? index : Math.min(s + 1, NEAR_ME_RADIUS_LADDER.length)))
  }, [])

  const exhausted = step >= NEAR_ME_RADIUS_LADDER.length

  return {
    /** Miles to filter by, or null once every rung has come back empty. */
    radius: exhausted ? null : NEAR_ME_RADIUS_LADDER[step],
    /** True once even the widest rung returned nothing. */
    exhausted,
    widen,
    widenTo,
  }
}
