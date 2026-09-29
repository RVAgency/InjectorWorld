'use client'

import { useEffect, useState } from 'react'
import { DirectoryClinicCard } from './DirectoryClinicCard'
import { ClinicCardSkeleton } from './ClinicCardSkeletonGrid'
import type { DirectoryClinic } from '@/lib/location-queries'
import { useSaved } from '@/components/account/SavedItemsProvider'

/** Cards revealed per "Load more" click. */
export const CLINIC_RESULTS_PAGE = 12

/**
 * Generic, paginated clinic result list. Used by /search.
 * Clinics arrive already merit-ordered from the server; this component only
 * handles the "Load more" window and saved-clinic state.
 *
 * Renamed from ProviderClinicResults on 2026-08-24, when the Providers
 * collection was removed and the provider tab lost its data source.
 *
 * Server paging (2026-09-28): with `canLoadMore` and `onLoadMore`, Load more
 * first reveals the rows already loaded, 12 at a time, and once those run out
 * asks the caller for the next server page. Without those props it behaves
 * exactly as before: a window over `clinics` and nothing else.
 */
export function ClinicResults({
  clinics,
  totalCount,
  canLoadMore = false,
  onLoadMore,
  loadingMore = false,
  loadError = null,
  onVisibleChange,
  showDistance = false,
}: {
  clinics: DirectoryClinic[]
  /** The real number of matches, when more exist than are loaded. Defaults to clinics.length. */
  totalCount?: number
  /** More rows exist on the server beyond `clinics`. */
  canLoadMore?: boolean
  /** Fetches the next server page. Resolves true when it appended rows. */
  onLoadMore?: () => Promise<boolean>
  loadingMore?: boolean
  loadError?: string | null
  /** Reports how many cards are on screen, for a count shown elsewhere. */
  onVisibleChange?: (visible: number) => void
  /**
   * Print each clinic's distance on its card (2026-09-30). Only when the list is
   * sorted nearest first, so the distances always read in order.
   */
  showDistance?: boolean
}) {
  const [visible, setVisible] = useState(CLINIC_RESULTS_PAGE)
  const { isSaved, toggle } = useSaved()
  // Sign-up gate removed 2026-08-06 (client request). "Load more" is
  // pagination, not a wall.

  const shown = Math.min(visible, clinics.length)
  useEffect(() => {
    onVisibleChange?.(shown)
  }, [shown, onVisibleChange])

  if (clinics.length === 0) {
    return <p className="text-body text-ink-secondary py-8">No clinics found yet.</p>
  }

  const hiddenLoaded = visible < clinics.length
  const serverMore = canLoadMore && Boolean(onLoadMore)
  const total = Math.max(totalCount ?? clinics.length, clinics.length)

  async function showMore() {
    if (hiddenLoaded) {
      setVisible((c) => c + CLINIC_RESULTS_PAGE)
      return
    }
    if (!onLoadMore || loadingMore) return
    // Reveal only when rows actually arrived, so a failed request leaves the
    // window where it was and the button offers a retry.
    if (await onLoadMore()) setVisible((c) => c + CLINIC_RESULTS_PAGE)
  }

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
        {clinics.slice(0, visible).map((c) => (
          <DirectoryClinicCard
            key={c.id}
            c={c}
            isSaved={isSaved('clinic', c.id)}
            isHighlighted={false}
            dist={showDistance && typeof c.distanceMiles === 'number' ? c.distanceMiles : null}
            onSave={() => toggle('clinic', c.id)}
            // /search keeps its original sizes: components/search is out of
            // scope for the 2026-09-24 page-speed work (hard rule).
            sizes="(min-width:1024px) 33vw, (min-width:768px) 50vw, 100vw"
          />
        ))}
        {loadingMore &&
          Array.from({ length: 6 }).map((_, i) => <ClinicCardSkeleton key={`sk-${i}`} />)}
      </div>
      {(hiddenLoaded || serverMore) && (
        <div className="mt-8 flex flex-col items-center gap-3">
          <p className="text-body-sm text-ink-tertiary">
            Showing {shown.toLocaleString()} of {total.toLocaleString()}
          </p>
          {loadError && !hiddenLoaded && (
            <p className="text-body-sm text-state-error" role="status">
              {loadError}
            </p>
          )}
          <button
            onClick={showMore}
            disabled={loadingMore}
            className="px-6 py-3 rounded-control border border-border bg-surface-canvas text-body-sm font-semibold text-ink-primary hover:border-brand-accent hover:bg-surface transition disabled:cursor-wait disabled:opacity-60"
          >
            {loadingMore ? 'Loading...' : loadError && !hiddenLoaded ? 'Try again' : 'Load more clinics'}
          </button>
        </div>
      )}
    </div>
  )
}
