'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { DirectoryClinicCard } from '@/components/shared/DirectoryClinicCard'
import { ListingFilters } from '@/components/shared/ListingFilters'
import { ClinicCardSkeleton, ClinicCardSkeletonGrid } from '@/components/shared/ClinicCardSkeletonGrid'
import { NearMeBoot } from '@/components/shared/NearMeBoot'
import { NearMeHeader } from '@/components/shared/NearMeHeader'
import { useNearMeRadius } from '@/components/shared/useNearMeRadius'
import { useNearMe } from '@/components/shared/useNearMe'
import {
  DEFAULT_LISTING_FILTERS,
  applyListingFilters,
  serverFilterKey,
  toServerFilterParams,
  withNearMeDefault,
  type ListingFilterValues,
} from '@/components/shared/applyListingFilters'
import { sortClinicsByDistance, sortClinicsByMeritWithinBuckets } from '@/lib/merit'
import type { DirectoryClinic } from '@/lib/location-queries'
import { fetchListingJson } from '@/lib/near-me-prefetch'
import { usePublishListing } from '@/lib/listing-count-store'

export function ServiceDirectory({
  clinics,
  serviceName,
  serviceSlug,
  stateSlug,
  totalClinics,
  brandOptions,
  listingHeading,
}: {
  clinics: DirectoryClinic[]
  serviceName: string
  serviceSlug: string
  /** When set, scopes the listing (and its server load-more) to one state. */
  stateSlug?: string
  totalClinics?: number
  brandOptions?: Array<{ id: string; name: string; slug: string }>
  /** Heading for the listing when no ZIP is in play. Pillar page only. */
  /**
   * Passed straight through to NearMeHeader, which fills `{count}` and `{s}`
   * from the live server total. A string, never a function: this component is
   * 'use client' and its callers are Server Components, so a function prop
   * cannot be serialized across that boundary and returned 500 on every page
   * that tried. See docs/LISTING-FIX-PLAN-2026-09-19.md section 4.9.
   */
  listingHeading?: string
}) {
  const [displayedClinics, setDisplayedClinics] = useState<DirectoryClinic[]>(clinics)
  const [listingFilters, setListingFilters] = useState<ListingFilterValues>(DEFAULT_LISTING_FILTERS)
  const [currentPage, setCurrentPage] = useState(1)
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
  const [serverTotal, setServerTotal] = useState<number | undefined>(totalClinics)

  /**
   * Near-me applies only on the service PILLAR page, where the visitor has
   * chosen no location. With `stateSlug` set this is /services/<svc>/<state>
   * and the choice is already made. The city page does not use this component
   * at all (it renders DirectoryClinicsView), so the absent-slug test cannot
   * leak there either.
   */
  const near = useNearMe()
  const nearMeEnabled = !stateSlug
  // The non-geo part of the panel filters. serverFilterKey also emits lat, lng
  // and radius, so those are nulled out here: the ladder must react to a brand,
  // service, type or rating change, and never to its own radius moving, which
  // would reset it on every rung and loop.
  const nearQueryKey = serverFilterKey({ ...listingFilters, lat: null, lng: null, radius: null })
  const nearRadius = useNearMeRadius(near.zip, nearQueryKey)
  // 'auto' means the visitor has not touched Distance, so the near-me default
  // applies. null means they explicitly chose "Any distance" and the page must
  // not put its own radius back.
  const [distanceChoice, setDistanceChoice] = useState<number | null | 'auto'>('auto')
  const effectiveFilters = useMemo(
    () =>
      withNearMeDefault(listingFilters, {
        enabled: nearMeEnabled,
        ready: near.status === 'ready',
        lat: near.lat,
        lng: near.lng,
        radius: distanceChoice === null ? null : nearRadius.radius,
        zip: near.zip,
      }),
    [listingFilters, nearMeEnabled, near.status, near.lat, near.lng, near.zip, nearRadius.radius, distanceChoice],
  )
  // How many of the listed clinics are in the visitor's own ZIP (2026-09-28),
  // from page 1 of the near-me query. Null whenever no ZIP was sent.
  const [zipCount, setZipCount] = useState<number | null>(null)
  // Declared here rather than beside the refetch effect below, because the two
  // phase flags under them are read by the grid, the count line and
  // showLoadMore, all of which come first in this component.
  //
  // Seeded with the SERVER-RENDERED listing's key, not the first client key: a
  // returning visitor's saved ZIP resolves before the first render finishes,
  // and seeding with the current key would mark that query as already fetched.
  const serverKey = serverFilterKey(effectiveFilters)
  // The key we have ASKED for. Guards against re-entry.
  const requestedKey = useRef(serverFilterKey(DEFAULT_LISTING_FILTERS))
  // The key currently ON SCREEN. Until these two agree the listing is still
  // loading, which is the window T2-03 lived in: geo had resolved, the heading
  // had already gone local, and the national list was still under it.
  const [renderedKey, setRenderedKey] = useState(serverFilterKey(DEFAULT_LISTING_FILTERS))

  // 'idle' is the server render and the first client render, where the real
  // list ships and CSS hides it. Everything after that is a real wait: geo
  // resolving, or resolved and its rows not back yet.
  const bootPhase = nearMeEnabled && near.status === 'idle'
  const listPending =
    nearMeEnabled && (near.status === 'resolving' || renderedKey !== serverKey)
  // The page hero's count follows this list (2026-09-28), see
  // lib/listing-count-store.ts. Pending while the list itself is not settled.
  usePublishListing(serverTotal, bootPhase || listPending || fetchPhase === 'replacing')

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
    setCurrentPage(1)
    setLoadError(null)
    setServerTotal(totalClinics)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceSlug, stateSlug])

  // Distance band first, merit inside the band. With no visitor location every
  // clinic shares one band and this is identical to the plain merit sort.
  //
  // With a radius set (the near-me default, or a distance picked in the panel)
  // the list is nearest first instead. The SQL makes the same choice on the
  // same test, so the browser never undoes the server's order.
  const byDistance = effectiveFilters.radius != null
  const meritSortedClinics = useMemo(
    () =>
      byDistance
        ? sortClinicsByDistance(displayedClinics)
        : sortClinicsByMeritWithinBuckets(displayedClinics),
    [displayedClinics, byDistance],
  )
  const filteredClinics = useMemo(
    () => applyListingFilters(meritSortedClinics, effectiveFilters, 'clinic').items,
    [meritSortedClinics, effectiveFilters],
  )

  const showLoadMore = Boolean(
    !listPending &&
      fetchPhase !== 'replacing' &&
      serverTotal &&
      displayedClinics.length < serverTotal,
  )

  async function fetchPage(nextPage: number, append: boolean) {
    setFetchPhase(append ? 'appending' : 'replacing')
    setLoadError(null)

    try {
      const params = new URLSearchParams({ serviceSlug: serviceSlug, page: String(nextPage), limit: '24' })
      if (stateSlug) params.set('stateSlug', stateSlug)
      // Brand / service / clinic type / rating are resolved server-side as of
      // 2026-08-07, so totalDocs is the real match count for the filters.
      toServerFilterParams(effectiveFilters).forEach((value, key) => params.set(key, value))

      // fetchListingJson: same request, but reuses NearMeBoot's early page-1
      // fetch when it is for this exact URL (lib/near-me-prefetch.ts).
      const data = await fetchListingJson(`/api/service-city-clinics?${params.toString()}`) as {
        clinics?: DirectoryClinic[]
        totalDocs?: number
        zipCount?: number | null
        widerRadius?: number | null
      }
      const nextClinics = Array.isArray(data.clinics) ? data.clinics : []

      setDisplayedClinics((prev) => {
        if (!append) return nextClinics
        const seen = new Set(prev.map((clinic) => clinic.id))
        return [...prev, ...nextClinics.filter((clinic) => !seen.has(clinic.id))]
      })
      if (typeof data.totalDocs === 'number') setServerTotal(data.totalDocs)
      if (!append) setZipCount(typeof data.zipCount === 'number' ? data.zipCount : null)
      // Nothing inside the current radius: widen one rung rather than printing
      // "No clinics match your filter" at someone who simply lives outside a
      // metro. Only ever fires on the automatic near-me radius, never on a
      // distance the visitor chose in the panel, and the ladder is finite.
      if (
        !append &&
        nearMeEnabled &&
        near.status === 'ready' &&
        listingFilters.radius == null &&
        effectiveFilters.radius != null &&
        Number(data.totalDocs ?? 0) === 0
      ) {
        // Straight to the first rung that has clinics, when the API named one.
        if ('widerRadius' in data) nearRadius.widenTo(data.widerRadius)
        else nearRadius.widen()
      }
      setCurrentPage(nextPage)
    } catch {
      setLoadError('Could not load more clinics. Please try again.')
    } finally {
      setFetchPhase('idle')
    }
  }

  async function handleLoadMore() {
    if (isLoading) return
    await fetchPage(currentPage + 1, true)
  }

  // Re-query from page 1 when a server-handled filter changes. The ref holds
  // the last key actually fetched, so the server-rendered first page is not
  // re-requested on mount.
  //
  // Seeded with the SERVER-RENDERED listing's key, not the first client key: a
  // returning visitor's saved ZIP resolves before the first render finishes,
  // and seeding with the current key would mark that query as already fetched.
  useEffect(() => {
    if (requestedKey.current === serverKey) return
    requestedKey.current = serverKey
    void fetchPage(1, false).then(() => {
      // A response for a key we have since moved past must not reveal the list.
      if (requestedKey.current === serverKey) setRenderedKey(serverKey)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey])

  return (
    <div className="md:flex md:items-start md:gap-6">
      <ListingFilters
        items={displayedClinics}
        mode="clinics"
        resultCount={filteredClinics.length}
        totalCount={serverTotal ?? displayedClinics.length}
        onChange={setListingFilters}
        brandOptions={brandOptions?.map((b) => ({ id: String(b.id), name: b.name }))}
        serverFiltered
        geo={near.status === 'ready' && near.lat != null && near.lng != null
          ? { lat: near.lat, lng: near.lng }
          : null}
        countsPending={listPending || fetchPhase === 'replacing'}
        autoRadius={effectiveFilters.radius}
        onDistanceChoice={setDistanceChoice}
      />

      {bootPhase && (
        <div data-nearme-boot="skeleton" className="min-w-0 flex-1">
          <NearMeBoot
            listUrl={`/api/service-city-clinics?serviceSlug=${encodeURIComponent(serviceSlug)}&page=1&limit=24`}
          />
          <div className="mb-6 h-8 w-64 rounded-control bg-surface animate-pulse" />
          {/* Same grid classes as this page's real grid, see 3.5 */}
          <ClinicCardSkeletonGrid className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6" />
        </div>
      )}

      <div
        data-nearme-boot={bootPhase ? 'list' : undefined}
        className="min-w-0 flex-1 pb-20 md:pb-0"
      >
        {!listPending && (
          <NearMeHeader
            near={near}
            enabled={nearMeEnabled}
            total={serverTotal}
            fallbackHeading={listingHeading}
            radiusMiles={effectiveFilters.radius}
            ladderExhausted={nearRadius.exhausted}
            zipCount={zipCount}
          />
        )}
        {listPending && <div className="mb-6 h-8 w-64 rounded-control bg-surface animate-pulse" />}

        {listPending || fetchPhase === 'replacing' ? (
          // One render, in final form. Without this the national list paints
          // first and is then replaced when geo lands. The same branch now also
          // covers a filter change, so stale rows never sit under a fresh count.
          <ClinicCardSkeletonGrid className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6" />
        ) : filteredClinics.length === 0 ? (
          <EmptyState serviceName={serviceName} />
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
              {filteredClinics.map((c, i) => (
                // Undefined means "not measured", so the card shows no distance
                // line rather than claiming 0 miles. No priority while the
                // near-me boot hides this list: those photos are about to be
                // replaced and would compete with the real LCP image.
                <DirectoryClinicCard key={c.id} c={c} dist={c.distanceMiles ?? null} priority={!bootPhase && i < 3} />
              ))}
              {fetchPhase === 'appending' &&
                Array.from({ length: 6 }).map((_, i) => <ClinicCardSkeleton key={`sk-${i}`} />)}
            </div>
            {/* serverTotal, not the totalClinics prop: with a ZIP applied the
                prop is still the national count, and a national number under a
                10-mile list is simply wrong. serverTotal tracks whatever the
                last query actually matched. */}
            <p className="mt-6 text-body-sm text-ink-tertiary text-center">
              Showing {filteredClinics.length} of {(serverTotal ?? filteredClinics.length).toLocaleString()} clinics
            </p>
            {loadError && (
              <p className="mt-4 text-body-sm text-state-error text-center" role="status">{loadError}</p>
            )}
            {showLoadMore && (
              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={isLoading}
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-control border border-border text-body-sm font-medium text-ink-primary hover:border-brand-accent hover:bg-surface transition disabled:opacity-50"
                >
                  {isLoading ? 'Loading...' : `Load more clinics (${Math.max(0, (serverTotal ?? 0) - displayedClinics.length).toLocaleString()} remaining)`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function EmptyState({ serviceName }: { serviceName: string }) {
  return (
    <div className="text-center py-20">
      <p className="text-body text-ink-secondary">
        No verified clinics offering {serviceName} yet.
      </p>
      <p className="text-body-sm text-ink-tertiary mt-2">
        Check back soon. We verify new clinics regularly.
      </p>
    </div>
  )
}
