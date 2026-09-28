'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { usePathname } from 'next/navigation'

/**
 * The live total of the clinic listing on screen, for the page hero
 * (2026-09-28, founder call).
 *
 * The hero count pill is server-rendered with the page's national number,
 * which is what crawlers get and must keep getting. The listing below it is a
 * client component that re-queries for the visitor's ZIP, a radius or the
 * filter panel, and until now the hero kept saying "51,227 clinics" above a
 * list of 131. The listing publishes its real total here and the hero pill
 * reads it, so the two numbers always agree.
 *
 * One listing per page. `scope` is the pathname it was published for, so after
 * a client-side navigation the next page's hero never shows the previous
 * page's number: it reads only a value published for its own path.
 */
export type LiveListing = {
  scope: string
  /** Matches for the current query, or null while not yet known. */
  total: number | null
  /** A re-query is on its way; the pill shows its loading state. */
  pending: boolean
  /** /clinics only: the hero stats for the listed set. */
  stats?: { stateCount: number; avgRating: string } | null
}

let current: LiveListing | null = null
const listeners = new Set<() => void>()

export function publishListing(next: LiveListing): void {
  const same =
    current &&
    current.scope === next.scope &&
    current.total === next.total &&
    current.pending === next.pending &&
    current.stats?.stateCount === next.stats?.stateCount &&
    current.stats?.avgRating === next.stats?.avgRating
  if (same) return
  current = next
  listeners.forEach((l) => l())
}

/** Called by a listing on unmount, so a stale value cannot outlive its page. */
export function clearListing(scope: string): void {
  if (current?.scope !== scope) return
  current = null
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * For a listing: report its current total and loading state for this page's
 * hero. One call at the top level of the listing component.
 */
export function usePublishListing(
  total: number | null | undefined,
  pending: boolean,
  stats?: { stateCount: number; avgRating: string } | null,
): void {
  const pathname = usePathname()
  const stateCount = stats?.stateCount
  const avgRating = stats?.avgRating
  useEffect(() => {
    publishListing({
      scope: pathname,
      total: typeof total === 'number' ? total : null,
      pending,
      stats: stateCount != null && avgRating != null ? { stateCount, avgRating } : null,
    })
  }, [pathname, total, pending, stateCount, avgRating])
  useEffect(() => () => clearListing(pathname), [pathname])
}

/** The live listing for `scope`, or null (server render, first paint, other page). */
export function useLiveListing(scope: string): LiveListing | null {
  const value = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
  return value && value.scope === scope ? value : null
}
