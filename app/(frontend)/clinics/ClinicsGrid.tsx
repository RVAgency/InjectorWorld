'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClinicListItem } from '@/lib/clinic-queries'
import type { MapPin } from '@/components/ui/ListingMapInner'
import { useSaved } from '@/components/account/SavedItemsProvider'
import { LazyMapMount } from '@/components/shared/LazyMapMount'
import { ListingFilters } from '@/components/shared/ListingFilters'
import { DirectoryClinicCard } from '@/components/shared/DirectoryClinicCard'
import { ClinicCardSkeleton, ClinicCardSkeletonGrid } from '@/components/shared/ClinicCardSkeletonGrid'
import { NearMeBoot } from '@/components/shared/NearMeBoot'
import { NearMeHeader } from '@/components/shared/NearMeHeader'
import { useNearMeRadius } from '@/components/shared/useNearMeRadius'
import { useNearMe } from '@/components/shared/useNearMe'
import { sortClinicsByDistance, sortClinicsByMeritWithinBuckets } from '@/lib/merit'
import { fetchListingJson } from '@/lib/near-me-prefetch'
import { usePublishListing } from '@/lib/listing-count-store'
import {
  DEFAULT_LISTING_FILTERS,
  applyListingFilters,
  serverFilterKey,
  toServerFilterParams,
  withNearMeDefault,
  type ListingFilterValues,
} from '@/components/shared/applyListingFilters'

const ListingMapInner = dynamic(
  () => import('@/components/ui/ListingMapInner').then((m) => m.ListingMapInner),
  {
    ssr: false,
    loading: () => (
      <div className="w-full rounded-2xl bg-surface border border-border flex items-center justify-center text-ink-tertiary text-body-sm" style={{ height: 480 }}>
        Loading map...
      </div>
    ),
  },
)

type FilterOption = { id: string; name: string }

type Props = {
  initialClinics: ClinicListItem[]
  totalClinics: number
  serviceOptions: FilterOption[]
  brandOptions: FilterOption[]
  loadFailed?: boolean
}

export function ClinicsGrid({
  initialClinics,
  totalClinics,
  serviceOptions,
  brandOptions,
  loadFailed = false,
}: Props) {
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list')
  const [listingFilters, setListingFilters] = useState<ListingFilterValues>(DEFAULT_LISTING_FILTERS)
  const [allClinics, setAllClinics] = useState(initialClinics)
  const [currentTotal, setCurrentTotal] = useState(totalClinics)
  const [selectedState, setSelectedState] = useState('')
  const [selectedCity, setSelectedCity] = useState('')
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
  // Tracks the server-rendered fetch specifically, separate from loadError
  // (which is about client-side load-more/filter requests). A DB-down page
  // load lands here with initialClinics=[] and loadFailed=true; any
  // successful client fetch afterward (a filter change, a retry) clears it,
  // so a legitimately empty filter result doesn't get stuck showing this.
  const [initialLoadFailed, setInitialLoadFailed] = useState(loadFailed)
  const router = useRouter()
  const pathname = usePathname()
  const { savedClinics, isSaved, toggle, loggedIn, ready } = useSaved()
  const [activeMapPin, setActiveMapPin] = useState<string | null>(null)

  /**
   * Near-me applies here because /clinics is the one route that renders this
   * grid: /clinics/<state> and /clinics/<state>/<city> use StateHubPage and
   * CityHubPage instead, so the visitor on this page has chosen no location.
   *
   * Asserted rather than assumed. `selectedState` / `selectedCity` are '' on
   * this page today, but if a location scope is ever set here the visitor has
   * made a choice and their IP must not override it -- the same rule the brand
   * and service listings enforce through their state and city slugs.
   */
  const near = useNearMe()
  const nearMeEnabled = !selectedState && !selectedCity
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
        // Ladder empty on the automatic radius, not "Any distance" picked.
        exhausted: distanceChoice !== null && nearRadius.exhausted,
      }),
    [listingFilters, nearMeEnabled, near.status, near.lat, near.lng, near.zip, nearRadius.radius, nearRadius.exhausted, distanceChoice],
  )
  // How many of the listed clinics are in the visitor's own ZIP (2026-09-28),
  // from page 1 of the near-me query. Null whenever no ZIP was sent.
  const [zipCount, setZipCount] = useState<number | null>(null)
  // States and average rating of the listed set, for the hero (2026-09-28).
  const [liveStats, setLiveStats] = useState<{ stateCount: number; avgRating: string } | null>(null)
  // Declared here rather than beside the refetch effect below, because the two
  // phase flags under them are read by the grid, the count line and hasMore,
  // all of which come first in this component.
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
  // The /clinics hero (count and stats) follows this list (2026-09-28), see
  // lib/listing-count-store.ts. Stats stay null until a query has returned
  // them, and the hero keeps the page's own numbers until then.
  usePublishListing(currentTotal, bootPhase || listPending || fetchPhase === 'replacing', liveStats)

  // Distance band first, merit inside the band (2026-08-15). The server has
  // already ordered the page by band; this settles the order within each one.
  // With no visitor location every clinic shares one band, so the result is the
  // server's own rating-count order, which is what this list showed before.
  //
  // With a radius set (the near-me default, or a distance picked in the panel)
  // the list is nearest first instead. The SQL makes the same choice on the
  // same test, so the browser never undoes the server's order.
  // Also nearest first once the ladder is exhausted (effectiveFilters.nearestFirst).
  const byDistance = effectiveFilters.radius != null || Boolean(effectiveFilters.nearestFirst)
  const bandSorted = useMemo(
    () =>
      byDistance
        ? sortClinicsByDistance(allClinics)
        : sortClinicsByMeritWithinBuckets(allClinics),
    [allClinics, byDistance],
  )
  const listingFiltered = useMemo(
    () => applyListingFilters(bandSorted, effectiveFilters, 'clinic').items,
    [bandSorted, effectiveFilters],
  )

  const hasMore =
    !listPending && fetchPhase !== 'replacing' && allClinics.length < currentTotal

  async function fetchClinics({
    stateCode,
    city,
    nextPage,
    append,
  }: {
    stateCode: string
    city: string
    nextPage: number
    append: boolean
  }) {
    setFetchPhase(append ? 'appending' : 'replacing')
    setLoadError(null)
    try {
      const params = new URLSearchParams({
        page: String(nextPage),
        limit: '24',
      })
      if (stateCode) params.set('stateCode', stateCode)
      if (city) params.set('city', city)
      // Brand / service / clinic type / rating are resolved in SQL as of
      // 2026-08-07, so the page that comes back is already filtered and
      // totalDocs is the real match count.
      toServerFilterParams(effectiveFilters).forEach((value, key) => params.set(key, value))

      // fetchListingJson: same request, but reuses NearMeBoot's early page-1
      // fetch when it is for this exact URL (lib/near-me-prefetch.ts).
      const json = await fetchListingJson(`/api/clinics-list?${params.toString()}`) as {
        clinics?: ClinicListItem[]
        totalDocs?: number
        zipCount?: number | null
        widerRadius?: number | null
        stats?: { stateCount: number; avgRating: string } | null
      }
      const nextClinics = Array.isArray(json.clinics) ? json.clinics : []

      setAllClinics((prev) => append ? [...prev, ...nextClinics] : nextClinics)
      setCurrentTotal(Number(json.totalDocs ?? nextClinics.length))
      if (!append) setZipCount(typeof json.zipCount === 'number' ? json.zipCount : null)
      if (!append) setLiveStats(json.stats ?? null)
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
        Number(json.totalDocs ?? 0) === 0
      ) {
        // Straight to the first rung that has clinics, when the API named one.
        if ('widerRadius' in json) nearRadius.widenTo(json.widerRadius)
        else nearRadius.widen()
      }
      setPage(nextPage)
      setInitialLoadFailed(false)
    } catch {
      // Was try/finally with no catch until 2026-08-17, so a failed request left
      // the visitor staring at "Loading..." with nothing else to go on and the
      // rejection unhandled. The brand and service listings already did this.
      setLoadError('Could not load more clinics. Please try again.')
    } finally {
      setFetchPhase('idle')
    }
  }

  async function handleStateChange(code: string) {
    setSelectedState(code)
    setSelectedCity('')
    setPage(1)
    await fetchClinics({ stateCode: code, city: '', nextPage: 1, append: false })
  }

  // handleCityChange lived here until 2026-09-10. Its only caller was
  // handleLocationChange, which went with the LocationFilterBar: picking a city
  // now means navigating to that city's own page from the hero picker, not
  // filtering this one. `selectedCity` stays because fetchClinics, loadMore and
  // the filter effect all still read it; handleStateChange keeps it at ''.

  async function loadMore() {
    await fetchClinics({
      stateCode: selectedState,
      city: selectedCity,
      nextPage: page + 1,
      append: true,
    })
  }

  // Re-query from page 1 whenever a server-handled filter changes. The ref
  // holds the last key actually fetched, so the first render (already
  // server-rendered, unfiltered) does not trigger a pointless round trip.
  //
  // Seeded with the SERVER-RENDERED listing's key, not the first client key: a
  // returning visitor's saved ZIP resolves before the first render finishes,
  // and seeding with the current key would mark that query as already fetched.
  useEffect(() => {
    if (requestedKey.current === serverKey) return
    requestedKey.current = serverKey
    void fetchClinics({ stateCode: selectedState, city: selectedCity, nextPage: 1, append: false }).then(
      () => {
        // A response for a key we have since moved past must not reveal the list.
        if (requestedKey.current === serverKey) setRenderedKey(serverKey)
      },
    )
    // fetchClinics reads the latest filters and location from the closure it is
    // recreated with each render; only the key drives the refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey])

  const mapPins: MapPin[] = listingFiltered.map((c) => ({
    id: c.id,
    lat: c.latitude,
    lng: c.longitude,
    title: c.clinicName,
    subtitle: c.neighborhood ? `${c.neighborhood}, ${c.city}` : c.city,
    meta: c.state,
    href: `/clinics/${c.stateSlug}/${c.citySlug}/${c.slug}`,
    rating: c.aggregateRating,
  }))

  return (
    <div className="md:flex md:items-start md:gap-6">
      <ListingFilters
        items={allClinics}
        mode="clinics"
        resultCount={listingFiltered.length}
        totalCount={currentTotal}
        onChange={setListingFilters}
        serviceOptions={serviceOptions}
        brandOptions={brandOptions}
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
          <NearMeBoot listUrl="/api/clinics-list?page=1&limit=24" />
          <div className="mb-6 h-8 w-64 rounded-control bg-surface animate-pulse" />
          {/* Same grid classes as this page's real grid, see 3.5 */}
          <ClinicCardSkeletonGrid className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-6" />
        </div>
      )}

      <div
        data-nearme-boot={bootPhase ? 'list' : undefined}
        className="min-w-0 flex-1 pb-24 md:pb-0"
      >
        {/* Filter bar - view toggle. The state/city selector moved into the
            page hero as a LocationPicker on 2026-09-10; keeping it here too
            would have been two controls doing the same job. */}
        <div className="flex flex-wrap gap-x-4 gap-y-3 items-center mb-5 pb-5 border-b border-border">
          <div className="flex-1" />

          {/* List / Map toggle - unchanged */}
          <div className="flex rounded-control border border-border overflow-hidden flex-shrink-0">
            {(['list', 'map'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-body-sm font-medium transition ${
                  viewMode === mode ? 'bg-brand-primary text-surface-canvas' : 'bg-surface-canvas text-ink-secondary hover:bg-surface'
                }`}
              >
                {mode === 'list' ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="3 11 22 2 13 21 11 13 3 11" />
                  </svg>
                )}
                {mode === 'list' ? 'List' : 'Map'}
              </button>
            ))}
          </div>
        </div>

        {/* ZIP heading + count + the ZIP changer. Rendered here, on the page
            canvas, never in the navy hero above -- nothing inside that band may
            carry text-ink-*. */}
        {!listPending && (
          <NearMeHeader
            near={near}
            enabled={nearMeEnabled}
            total={currentTotal}
            radiusMiles={effectiveFilters.radius}
            ladderExhausted={nearRadius.exhausted}
            zipCount={zipCount}
          />
        )}
        {listPending && <div className="mb-6 h-8 w-64 rounded-control bg-surface animate-pulse" />}

        {/* Count + saved */}
        <div className="flex items-center justify-between mb-6">
          {/* Held back while the ZIP resolves, for the same reason the cards
              are: a national count that changes a moment later is the flash. */}
          <p className="text-body-sm text-ink-tertiary">
            {listPending ? ' ' : `Showing ${listingFiltered.length.toLocaleString()} of ${currentTotal.toLocaleString()} clinics`}
          </p>
          {savedClinics.size > 0 && (
            <span className="flex items-center gap-1.5 text-body-sm text-brand-accent">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
              </svg>
              {savedClinics.size} saved
            </span>
          )}
        </div>

        {/* Map */}
        {viewMode === 'map' && (
          <div className="mb-8">
            {/* mapPins comes from listingFiltered, which still holds the
                previous rows while the listing is pending, so the map kept
                showing old locations beside a skeleton grid. Same gate as the
                grid. See docs/LISTING-FIX-PLAN-2026-09-19.md section 5.4. */}
            {listPending || fetchPhase === 'replacing' ? (
              <div className="w-full rounded-2xl bg-surface border border-border animate-pulse" style={{ height: 480 }} />
            ) : (
              <LazyMapMount
                placeholder={
                  <div className="w-full rounded-2xl bg-surface border border-border flex items-center justify-center text-ink-tertiary text-body-sm" style={{ height: 480 }}>
                    Loading map...
                  </div>
                }
              >
                <ListingMapInner
                  pins={mapPins}
                  activePinId={activeMapPin}
                  onPinClick={setActiveMapPin}
                  height={480}
                />
              </LazyMapMount>
            )}
            <p className="text-caption text-ink-tertiary mt-2 text-center">Click a pin to see the clinic below.</p>
          </div>
        )}

        {/* Grid */}
        {listPending || fetchPhase === 'replacing' ? (
          // One render, in final form. Without this the national list paints
          // first and is then replaced when geo lands. The same branch now also
          // covers a filter change, so stale rows never sit under a fresh count.
          <ClinicCardSkeletonGrid className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-6" />
        ) : listingFiltered.length === 0 && initialLoadFailed ? (
          <div className="text-center py-20">
            <p className="text-body text-ink-secondary">Couldn&apos;t load clinics right now.</p>
            <p className="text-body-sm text-ink-tertiary mt-1">
              This isn&apos;t an empty directory, something went wrong loading it.
            </p>
            <button
              className="mt-4 text-brand-accent text-body-sm underline"
              onClick={() => fetchClinics({ stateCode: selectedState, city: selectedCity, nextPage: 1, append: false })}
            >
              Try again
            </button>
          </div>
        ) : listingFiltered.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-body text-ink-secondary">No clinics match your filter.</p>
            <p className="text-body-sm text-ink-tertiary mt-1">
              Looking for a specific city? <Link href="/states" className="text-brand-accent underline">Browse the full directory by state</Link>.
            </p>
            <button
              className="mt-4 text-brand-accent text-body-sm underline"
              onClick={() => {
                // The panel keeps its selections in the URL, so clearing them
                // means clearing the URL. handleStateChange('') only reset the
                // state/city scope and re-ran the same filtered query, which
                // left the visitor staring at the same empty state.
                // See docs/LISTING-FIX-PLAN-2026-09-19.md section 5.2.
                router.replace(pathname, { scroll: false })
              }}
            >
              Clear filters
            </button>
          </div>
        ) : (() => {
          /* Sign-up gate removed 2026-08-06 (client request): nothing on a
             listing is held back from anonymous visitors any more. The save
             prompt is a separate thing and still stands. */
          return (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-6">
                {listingFiltered.map((c, i) => (
                  <DirectoryClinicCard
                    key={c.id}
                    c={c}
                    isSaved={isSaved('clinic', c.id)}
                    isHighlighted={activeMapPin === c.id}
                    // Undefined means "not measured", so the card shows no
                    // distance line rather than claiming 0 miles.
                    dist={c.distanceMiles ?? null}
                    onSave={() => toggle('clinic', c.id)}
                    // No priority while the near-me boot hides this list.
                    priority={!bootPhase && i < 3}
                    // This grid is one column until md (768), not sm, so the
                    // 640-767 band is full width here.
                    sizes="(min-width:1280px) 290px, (min-width:1024px) 22vw, (min-width:768px) 300px, 100vw"
                  />
                ))}
                {fetchPhase === 'appending' &&
                  Array.from({ length: 6 }).map((_, i) => <ClinicCardSkeleton key={`sk-${i}`} />)}
              </div>
              {loadError && (
                <p className="mt-4 text-center text-body-sm text-state-error" role="status">
                  {loadError}
                </p>
              )}
              {hasMore && !isLoading && (
                <div className="mt-8 text-center">
                  <button
                    onClick={loadMore}
                    className="inline-flex items-center gap-2 px-6 py-3 rounded-control border border-border text-body-sm font-medium text-ink-primary hover:border-brand-accent hover:bg-surface transition"
                  >
                    {loadError
                      ? 'Try again'
                      : `Load more clinics (${Math.max(0, currentTotal - allClinics.length).toLocaleString()} remaining)`}
                  </button>
                </div>
              )}
            </>
          )
        })()}
      </div>
    </div>
  )
}
