'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import Link from 'next/link'
import { ListingFilters } from './ListingFilters'
import { DirectoryClinicCard } from './DirectoryClinicCard'
import { ClinicCardSkeleton, ClinicCardSkeletonGrid } from './ClinicCardSkeletonGrid'
import { NearMeBoot } from './NearMeBoot'
import { NearMeHeader } from './NearMeHeader'
import { useNearMeRadius } from './useNearMeRadius'
import { useNearMe } from './useNearMe'
import {
  DEFAULT_LISTING_FILTERS,
  applyListingFilters,
  serverFilterKey,
  toServerFilterParams,
  withNearMeDefault,
  type ListingFilterValues,
} from './applyListingFilters'
import { sortClinicsByDistance, sortClinicsByMeritWithinBuckets } from '@/lib/merit'
import type { DirectoryClinic } from '@/lib/location-queries'
import { fetchListingJson } from '@/lib/near-me-prefetch'
import { usePublishListing } from '@/lib/listing-count-store'

type FilterOption = { id: string; name: string }

type Props = {
  clinics: DirectoryClinic[]
  serviceOptions?: FilterOption[]
  brandOptions?: FilterOption[]
  emptyMessage?: string
  emptyLink?: { href: string; label: string }
  brandSlug?: string
  stateSlug?: string
  citySlug?: string
  totalClinics?: number
  /** Heading for the listing when no ZIP is in play. Pillar page only. */
  /**
   * Passed straight through to NearMeHeader, which fills `{count}` and `{s}`
   * from the live server total. A string, never a function: this component is
   * 'use client' and its callers are Server Components, so a function prop
   * cannot be serialized across that boundary and returned 500 on every page
   * that tried. See docs/LISTING-FIX-PLAN-2026-09-19.md section 4.9.
   */
  listingHeading?: string
}

export function BrandDirectoryListing({
  clinics,
  serviceOptions,
  brandOptions,
  emptyMessage,
  emptyLink,
  brandSlug,
  stateSlug,
  citySlug,
  totalClinics,
  listingHeading,
}: Props) {
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
   * Near-me applies only where the visitor has chosen no location, i.e. the
   * brand PILLAR page. On /brands/<brand>/<state> and .../<city> they have
   * already chosen one and overriding it with their IP would be wrong.
   *
   * The test is the absence of both slugs rather than a new boolean prop, so it
   * is structurally impossible to leak onto a state or city page: those routes
   * cannot render this component without passing them.
   */
  const near = useNearMe()
  const nearMeEnabled = !stateSlug && !citySlug
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
  // Seeded with the key of the SERVER-RENDERED listing (no filters, no
  // near-me), not with the first client key. A returning visitor resolves their
  // saved ZIP before the first render finishes, so seeding with the current key
  // would record the ZIP query as already fetched and leave the national list
  // on screen under a local heading.
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
  }, [brandSlug, stateSlug, citySlug])

  // Distance band first, merit inside the band. When the visitor could not be
  // located, every clinic has no distance, every clinic lands in the same band,
  // and this degrades to exactly the plain merit sort it replaced.
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
  const filtered = useMemo(
    () => applyListingFilters(meritSortedClinics, effectiveFilters, 'clinic').items,
    [meritSortedClinics, effectiveFilters],
  )

  const showLoadMore = Boolean(
    !listPending &&
      fetchPhase !== 'replacing' &&
      brandSlug &&
      serverTotal &&
      displayedClinics.length < serverTotal,
  )

  async function fetchPage(nextPage: number, append: boolean) {
    if (!brandSlug) return
    setFetchPhase(append ? 'appending' : 'replacing')
    setLoadError(null)

    try {
      const params = new URLSearchParams({
        brandSlug,
        page: String(nextPage),
        limit: '24',
      })
      if (stateSlug) params.set('stateSlug', stateSlug)
      if (citySlug) params.set('citySlug', citySlug)
      // Brand / service / clinic type / rating are resolved server-side as of
      // 2026-08-07, so totalDocs is the real match count for the filters.
      toServerFilterParams(effectiveFilters).forEach((value, key) => params.set(key, value))

      // fetchListingJson: same request, but reuses NearMeBoot's early page-1
      // fetch when it is for this exact URL (lib/near-me-prefetch.ts).
      const data = await fetchListingJson(`/api/brand-clinics?${params.toString()}`) as {
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
  // Seeded with the key of the SERVER-RENDERED listing (no filters, no
  // near-me), not with the first client key. A returning visitor resolves their
  // saved ZIP before the first render finishes, so seeding with the current key
  // would record the ZIP query as already fetched and leave the national list
  // on screen under a local heading.
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
        resultCount={filtered.length}
        totalCount={serverTotal ?? displayedClinics.length}
        onChange={setListingFilters}
        serviceOptions={serviceOptions}
        brandOptions={brandOptions}
        // Only the brand routes have a server endpoint to re-query.
        serverFiltered={Boolean(brandSlug)}
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
            listUrl={brandSlug ? `/api/brand-clinics?brandSlug=${encodeURIComponent(brandSlug)}&page=1&limit=24` : undefined}
          />
          <div className="mb-6 h-8 w-64 rounded-control bg-surface animate-pulse" />
          {/* Same grid classes as this page's real grid, see 3.5 */}
          <ClinicCardSkeletonGrid />
        </div>
      )}

      <div data-nearme-boot={bootPhase ? 'list' : undefined} className="min-w-0 flex-1">
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
          // The list appears once, in its final form, instead of appearing
          // national and then being replaced when geo lands. The same branch
          // now also covers a filter change, so stale rows never sit under a
          // fresh count.
          <ClinicCardSkeletonGrid />
        ) : filtered.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
            {filtered.map((c, i) => (
              // Distance is what makes a near-me list readable: without it the
              // order looks arbitrary even when it is correct. Undefined means
              // "not measured", so the card shows no distance line rather than
              // claiming 0 miles. No priority while the near-me boot hides this
              // list: those photos are about to be replaced.
              <DirectoryClinicCard key={c.id} c={c} dist={c.distanceMiles ?? null} priority={!bootPhase && i < 3} />
            ))}
            {fetchPhase === 'appending' &&
              Array.from({ length: 6 }).map((_, i) => <ClinicCardSkeleton key={`sk-${i}`} />)}
          </div>
        ) : (
          <div className="text-center py-16">
            <p className="text-body text-ink-secondary mb-3">
              {emptyMessage ?? 'No clinics match the selected filters.'}
            </p>
            {emptyLink && (
              <Link href={emptyLink.href} className="text-brand-accent hover:underline text-body-sm">
                {emptyLink.label}
              </Link>
            )}
          </div>
        )}

        {loadError && (
          <p className="mt-4 text-body-sm text-state-error" role="status">
            {loadError}
          </p>
        )}

        {showLoadMore && (
          <div className="mt-8 flex justify-center">
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
      </div>
    </div>
  )
}
