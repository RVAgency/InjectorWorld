'use client'
import { usePublishListing } from '@/lib/listing-count-store'

import dynamic from 'next/dynamic'
import { useEffect, useState, useMemo, useRef } from 'react'
import { DirectoryClinicCard } from './DirectoryClinicCard'
import { ClinicCardSkeleton, ClinicCardSkeletonGrid } from './ClinicCardSkeletonGrid'
import { LazyMapMount } from './LazyMapMount'
import { ListingFilters } from './ListingFilters'
import type { DirectoryClinic } from '@/lib/location-queries'
import type { MapPin } from '@/components/ui/ListingMapInner'
import { useSaved } from '@/components/account/SavedItemsProvider'
import { distinctNeighborhoods, matchesNeighborhood } from '@/lib/neighborhood-filter'
import { sortClinicsByMeritWithinBuckets } from '@/lib/merit'
import {
  DEFAULT_LISTING_FILTERS,
  applyListingFilters,
  serverFilterKey,
  toServerFilterParams,
  type ListingFilterValues,
} from './applyListingFilters'

const ListingMapInner = dynamic(
  () => import('@/components/ui/ListingMapInner').then((m) => m.ListingMapInner),
  {
    ssr: false,
    loading: () => (
      <div className="w-full rounded-2xl bg-surface border border-border flex items-center justify-center text-ink-tertiary text-body-sm" style={{ height: 420 }}>
        Loading map…
      </div>
    ),
  },
)

export function DirectoryClinicsView({
  clinics,
  totalClinics,
  loadMoreUrl,
  brandOptions,
}: {
  clinics: DirectoryClinic[]
  totalClinics?: number
  loadMoreUrl?: string
  brandOptions?: Array<{ id: string; name: string }>
}) {
  const [displayedClinics, setDisplayedClinics] = useState(clinics)
  const [page, setPage] = useState(1)
  /**
   * What the in-flight request is going to do to the grid (2026-09-19).
   *
   *   'replacing' - a page-1 re-query. The rows on screen are about to be
   *                 thrown away, so showing them under an already-updated count
   *                 is a lie. The skeleton takes their place.
   *   'appending' - Load more. The rows on screen are still correct, so they
   *                 stay and placeholder cards fill the end of the grid.
   *
   * See docs/LISTING-FIX-PLAN-2026-09-19.md TASK 3.
   */
  const [fetchPhase, setFetchPhase] = useState<'idle' | 'replacing' | 'appending'>('idle')
  const isLoading = fetchPhase !== 'idle'
  const [loadError, setLoadError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list')
  const { isSaved, toggle } = useSaved()
  const [activeMapPin, setActiveMapPin] = useState<string | null>(null)
  const [neighborhood, setNeighborhood] = useState('')
  const [listingFilters, setListingFilters] = useState<ListingFilterValues>(DEFAULT_LISTING_FILTERS)
  const [serverTotal, setServerTotal] = useState<number | undefined>(totalClinics)

  /**
   * Keyed on the PAGE, not on the props' object identity (2026-09-20).
   *
   * router.replace, which both Apply and Clear all call, re-delivers this
   * route's payload, so `clinics` arrives as a new array with identical
   * contents. With it in the deps this effect fired and overwrote the rows the
   * listing had just fetched, putting the server's unfiltered page 1 and total
   * back on screen. Measured on /brands/botox: Clear all produced "Showing 2 of
   * 51,074 results" under "51,074 clinics within 10 miles". A background ISR
   * revalidation must not replace the visitor's current view either.
   * See docs/LISTING-FIX-PLAN-2026-09-19.md section 5.1.
   */
  useEffect(() => {
    setDisplayedClinics(clinics)
    setPage(1)
    setLoadError(null)
    setServerTotal(totalClinics)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadMoreUrl])

  const neighborhoodOptions = useMemo(
    () => distinctNeighborhoods(displayedClinics.map((c) => c.neighborhood)),
    [displayedClinics],
  )
  // Distance band first, merit inside the band. With no visitor location every
  // clinic shares one band and this is identical to the plain merit sort.
  const meritSortedClinics = useMemo(
    () => sortClinicsByMeritWithinBuckets(displayedClinics),
    [displayedClinics],
  )
  const listingFiltered = useMemo(
    () => applyListingFilters(meritSortedClinics, listingFilters, 'clinic').items,
    [meritSortedClinics, listingFilters],
  )
  const shown = useMemo(
    () => listingFiltered.filter((c) => matchesNeighborhood(c.neighborhood, neighborhood)),
    [listingFiltered, neighborhood],
  )
  // Sign-up gate removed 2026-08-06 (client request); every clinic in the list
  // renders for anonymous visitors too.
  const hasMore = Boolean(
    fetchPhase !== 'replacing' &&
      loadMoreUrl &&
      serverTotal &&
      displayedClinics.length < serverTotal,
  )
  // The page hero's count follows this list (2026-09-28), see
  // lib/listing-count-store.ts.
  usePublishListing(serverTotal, fetchPhase === 'replacing')

  async function fetchPage(nextPage: number, append: boolean) {
    if (!loadMoreUrl) return

    setFetchPhase(append ? 'appending' : 'replacing')
    setLoadError(null)

    const separator = loadMoreUrl.includes('?') ? '&' : '?'
    try {
      // Brand / service / clinic type / rating are resolved server-side as of
      // 2026-08-07, so totalDocs is the real match count for the filters.
      const filterQuery = toServerFilterParams(listingFilters).toString()
      const res = await fetch(
        `${loadMoreUrl}${separator}page=${nextPage}&limit=24${filterQuery ? `&${filterQuery}` : ''}`,
      )
      if (!res.ok) throw new Error('Unable to load more clinics.')

      const data = await res.json() as { clinics?: DirectoryClinic[]; totalDocs?: number }
      const nextClinics = Array.isArray(data.clinics) ? data.clinics : []

      setDisplayedClinics((prev) => {
        if (!append) return nextClinics
        const seen = new Set(prev.map((clinic) => clinic.id))
        return [...prev, ...nextClinics.filter((clinic) => !seen.has(clinic.id))]
      })
      if (typeof data.totalDocs === 'number') setServerTotal(data.totalDocs)
      setPage(nextPage)
    } catch {
      setLoadError('Could not load more clinics. Please try again.')
    } finally {
      setFetchPhase('idle')
    }
  }

  async function loadMore() {
    if (isLoading || !hasMore) return
    await fetchPage(page + 1, true)
  }

  // Re-query from page 1 when a server-handled filter changes. The ref holds
  // the last key actually fetched, so the server-rendered first page is not
  // re-requested on mount.
  const serverKey = serverFilterKey(listingFilters)
  const appliedServerKey = useRef(serverKey)
  useEffect(() => {
    if (appliedServerKey.current === serverKey) return
    appliedServerKey.current = serverKey
    void fetchPage(1, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey])

  if (displayedClinics.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-brand-accent-soft flex items-center justify-center mx-auto mb-4">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--brand-accent))" strokeWidth="2">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </div>
        <p className="text-body text-ink-secondary mb-1">No clinics listed in this area yet.</p>
        <p className="text-body-sm text-ink-tertiary">We are actively adding clinics. Check the Providers tab above.</p>
      </div>
    )
  }

  const mapPins: MapPin[] = shown.map((c) => ({
    id: c.id,
    lat: c.latitude,
    lng: c.longitude,
    title: c.clinicName,
    subtitle: c.neighborhood ? `${c.neighborhood}, ${c.city}` : c.city,
    meta: `${c.providerCount} ${c.providerCount === 1 ? 'provider' : 'providers'}`,
    href: `/clinics/${c.stateSlug}/${c.citySlug}/${c.slug}`,
    rating: c.aggregateRating,
  }))

  return (
    <div className="md:flex md:items-start md:gap-6">
      <ListingFilters
        items={displayedClinics}
        mode="clinics"
        resultCount={shown.length}
        totalCount={serverTotal ?? displayedClinics.length}
        onChange={setListingFilters}
        brandOptions={brandOptions}
        // Callers without a loadMoreUrl have nothing to re-query, so they stay
        // on browser-side filtering over the rows they were handed.
        serverFiltered={Boolean(loadMoreUrl)}
        countsPending={fetchPhase === 'replacing'}
      />

      <div className="min-w-0 flex-1 pb-20 md:pb-0">
      {/* Count + filters + view toggle */}
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <p className="text-body-sm text-ink-tertiary">
          {fetchPhase === 'replacing'
            ? ' '
            : `Showing ${shown.length.toLocaleString()} of ${(serverTotal ?? shown.length).toLocaleString()} clinics`}
          {shown.filter((c) => isSaved('clinic', c.id)).length > 0 && (
            <span className="ml-3 inline-flex items-center gap-1.5 text-brand-accent">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
              </svg>
              {shown.filter((c) => isSaved('clinic', c.id)).length} saved
            </span>
          )}
        </p>

        <div className="flex items-center gap-2 flex-wrap">
          {neighborhoodOptions.length > 0 && (
            <select
              value={neighborhood}
              onChange={(e) => setNeighborhood(e.target.value)}
              className="px-3 py-2 rounded-control border border-border text-body-sm text-ink-primary bg-surface-canvas focus:outline-none focus:border-brand-accent cursor-pointer"
              aria-label="Filter clinics by neighborhood"
            >
              <option value="">All neighborhoods</option>
              {neighborhoodOptions.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          )}

          <div className="flex rounded-control border border-border overflow-hidden flex-shrink-0">
          {(['list', 'map'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={viewMode === mode}
              onClick={() => setViewMode(mode)}
              className={`flex items-center gap-1.5 px-4 py-1.5 text-body-sm font-medium transition ${
                viewMode === mode ? 'bg-brand-primary text-surface-canvas' : 'bg-surface-canvas text-ink-secondary hover:bg-surface'
              }`}
            >
              {mode === 'list' ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
                  <line x1="8" y1="2" x2="8" y2="18" /><line x1="16" y1="6" x2="16" y2="22" />
                </svg>
              )}
              {mode === 'list' ? 'List' : 'Map'}
            </button>
          ))}
        </div>
      </div>
      </div>

      {/* Map */}
      {viewMode === 'map' && (
        <div className="mb-6">
          <LazyMapMount
            placeholder={
              <div className="w-full rounded-2xl bg-surface border border-border flex items-center justify-center text-ink-tertiary text-body-sm" style={{ height: 460 }}>
                Loading map...
              </div>
            }
          >
            <ListingMapInner
              pins={mapPins}
              activePinId={activeMapPin}
              onPinClick={setActiveMapPin}
              height={460}
            />
          </LazyMapMount>
          <p className="text-caption text-ink-tertiary mt-2 text-center">Click a pin to highlight the clinic below.</p>
        </div>
      )}

      {/* Grid */}
      {fetchPhase === 'replacing' ? (
        // The rows on screen are about to be thrown away, so the skeleton takes
        // their place rather than leaving stale cards under a fresh count.
        <ClinicCardSkeletonGrid className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5" />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {shown.map((c, i) => (
            <DirectoryClinicCard
              key={c.id}
              c={c}
              isSaved={isSaved('clinic', c.id)}
              isHighlighted={activeMapPin === c.id}
              dist={null}
              onSave={() => toggle('clinic', c.id)}
              priority={i < 3}
            />
          ))}
          {fetchPhase === 'appending' &&
            Array.from({ length: 6 }).map((_, i) => <ClinicCardSkeleton key={`sk-${i}`} />)}
        </div>
      )}
      {loadError && (
        <p className="mt-4 text-body-sm text-state-error text-center" role="status">
          {loadError}
        </p>
      )}
      {hasMore && (
        <div className="mt-8 text-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={isLoading}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-control border border-border text-body-sm font-medium text-ink-primary hover:border-brand-accent hover:bg-surface transition disabled:opacity-50"
          >
            {isLoading ? 'Loading...' : `Load more clinics (${Math.max(0, (serverTotal ?? 0) - displayedClinics.length).toLocaleString()} remaining)`}
          </button>
        </div>
      )}
      </div>
    </div>
  )
}
