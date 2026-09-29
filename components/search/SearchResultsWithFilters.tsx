'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ListingFilters } from '@/components/shared/ListingFilters'
import { ClinicResults, CLINIC_RESULTS_PAGE } from '@/components/shared/ClinicResults'
import { ClinicCardSkeletonGrid } from '@/components/shared/ClinicCardSkeletonGrid'
import { LocationFilterBar } from '@/components/shared/LocationFilterBar'
import type { ListingFilterValues } from '@/components/shared/applyListingFilters'
import type { DirectoryClinic, StateFilterOption } from '@/lib/location-queries'
import { usePublishListing } from '@/lib/listing-count-store'

/**
 * The url keys the listing panel writes (FILTER_KEYS in ListingFilters.tsx).
 * "Clear filters" on an empty result removes exactly these, and nothing about
 * the search itself.
 */
const LISTING_FILTER_KEYS = [
  'radius', 'rating', 'virtual', 'priceMin', 'priceMax', 'lang', 'type', 'loyalty', 'brand', 'svc', 'lat', 'lng',
]

/**
 * Identity of the panel filters that change the result set, used only to notice
 * that the visitor changed them. Coordinates are left out on purpose: the panel
 * fills them in from the visitor's IP after mount, which changes nothing on the
 * server, and counting that as a change would show a skeleton for a request
 * that never happens.
 */
function filterKey(f: ListingFilterValues): string {
  const list = (v: string[]) => [...v].sort().join(',')
  // "Any distance" counts: on a ZIP search it lifts the 3-mile limit.
  const distance = f.radius ?? (f.anyDistance ? 'any' : '')
  return [list(f.brands), list(f.services), list(f.clinicTypes), f.rating ?? '', distance].join('|')
}

/** The search itself (query and place), without the panel's filters or paging. */
function searchIdentity(searchQuery: string): string {
  const params = new URLSearchParams(searchQuery)
  LISTING_FILTER_KEYS.forEach((key) => params.delete(key))
  params.delete('page')
  return params.toString()
}

/** If a navigation never lands, stop showing the skeleton after this long. */
const PENDING_TIMEOUT_MS = 15_000

/**
 * /search results + the filter sidebar (the same ListingFilters component every
 * clinic listing uses). Search is location-first like the Clinics path, so both
 * the Brand and Service filters are shown, per the locked sidebar rule.
 *
 * Server-filtered as of 2026-09-28, like every other listing. The panel writes
 * its filters to the url; the page is dynamic, so that re-renders it on the
 * server, where the filters run in SQL across every match and the total is
 * real. Until then the filters ran here, in the browser, over the 100 rows page
 * 1 had loaded: a brand filter only ever searched those 100, the counts
 * described the 100, and "Clinic type" always came back empty.
 *
 * While the new render is on its way the list shows a skeleton, the same one the
 * other listings show during a filter change, so stale rows never sit under a
 * fresh selection. Past the first page, Load more asks /api/search/more for the
 * next page of the same search (same query string, so the same filters).
 *
 * Distance (2026-09-29): a search with a place of its own (a ZIP, a city, New
 * York City) hands the panel that place and the radius it already applies, so
 * the control reads "3 mi" on a ZIP search like the pillar pages, and a picked
 * Distance is measured from the searched place, not from the visitor. See
 * SearchParams.distance in lib/search-queries.ts.
 *
 * `stateOptions` is only ever non-empty when the user hasn't typed a location
 * themselves (the page decides this by checking the raw `location` param,
 * not `state`/`city` -- see app/(frontend)/search/page.tsx). Picking a
 * state/city here re-navigates with `state`/`city` params (kept separate
 * from `location` on purpose): if they shared the same param, selecting a
 * state made the code think "the user typed a location" and hid the very
 * bar that just set it -- a self-defeating loop that was the actual bug.
 */
export function SearchResultsWithFilters({
  clinics,
  totalCount,
  brandOptions,
  serviceOptions,
  stateOptions,
  initialState,
  initialCity,
  searchQuery,
  pageSize,
  resultCap,
  filtersActive,
  distanceOrigin,
  appliedRadiusMiles,
  sortedByDistance = false,
}: {
  /** Page 1 of the search, already filtered on the server. */
  clinics: DirectoryClinic[]
  /** Real number of matches for the search and its filters. */
  totalCount: number
  brandOptions: { id: string; name: string }[]
  serviceOptions: { id: string; name: string }[]
  stateOptions: StateFilterOption[]
  initialState: string
  initialCity: string
  /** The query string this page was rendered for; Load more sends it back. */
  searchQuery: string
  /** Rows per server page. */
  pageSize: number
  /** Deepest result search can reach (see SEARCH_RESULT_CAP). */
  resultCap: number
  /** Whether any listing filter is applied to this render. */
  filtersActive: boolean
  /**
   * The searched place the panel measures Distance from (2026-09-29), or null
   * when the search names no place and the panel uses the visitor's location.
   */
  distanceOrigin: { lat: number; lng: number } | null
  /** Radius the list is already cut to, shown in the Distance control. */
  appliedRadiusMiles: number | null
  /** The list is nearest first, so each card shows its distance (2026-09-30). */
  sortedByDistance?: boolean
}) {
  const router = useRouter()
  // Seeded from the URL (not always '') so the dropdown reflects the current
  // selection after navigation, refresh, or browser back/forward -- not just
  // whatever was clicked in this particular client session.
  const [selectedState, setSelectedState] = useState(initialState)
  const [selectedCity, setSelectedCity] = useState(initialCity)

  // Pages 2+ from /api/search/more, appended to page 1.
  const [extra, setExtra] = useState<DirectoryClinic[]>([])
  const [nextPage, setNextPage] = useState(2)
  const [exhausted, setExhausted] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // True from a filter or location change until the new server render lands.
  const [pending, setPending] = useState(false)
  const [visibleCount, setVisibleCount] = useState(() => Math.min(CLINIC_RESULTS_PAGE, clinics.length))

  const lastFilterKey = useRef<string | null>(null)
  // Bumped on every new server render, so a Load more answer that belongs to
  // the previous search is dropped instead of appended to this one.
  const generation = useRef(0)
  const firstRender = useRef(true)

  // A new server render (new query, filters or location) replaces everything
  // this component accumulated for the previous one.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    // The dropdown follows the url of the render that just landed. Seeding
    // useState from the url only covered the first mount: after browser Back
    // from ?state=TX the list was national again while the dropdown still read
    // "Texas" (seen live on staging and production, 2026-09-28).
    setSelectedState(initialState)
    setSelectedCity(initialCity)
    generation.current += 1
    setExtra([])
    setNextPage(2)
    setExhausted(false)
    setLoadingMore(false)
    setLoadError(null)
    setPending(false)
    setVisibleCount(Math.min(CLINIC_RESULTS_PAGE, clinics.length))
  }, [clinics])

  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setPending(false), PENDING_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [pending])

  // Must keep one identity: ListingFilters reports through an effect keyed on it.
  const handleFiltersChange = useCallback((filters: ListingFilterValues) => {
    const key = filterKey(filters)
    // The first report is the url this page was rendered for, not a change.
    if (lastFilterKey.current !== null && key !== lastFilterKey.current) setPending(true)
    lastFilterKey.current = key
  }, [])

  const allClinics = useMemo(() => {
    // Deduplicated by id: two clinics with an identical score can trade places
    // between two page requests, and one must not show twice.
    const seen = new Set<string>()
    const out: DirectoryClinic[] = []
    for (const c of [...clinics, ...extra]) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      out.push(c)
    }
    return out
  }, [clinics, extra])

  // The page's count pills follow this list and pulse with it (2026-09-28),
  // see lib/listing-count-store.ts.
  usePublishListing(totalCount, pending)

  const reachable = Math.min(totalCount, resultCap)
  const canLoadMore = !exhausted && allClinics.length < reachable

  const loadMore = useCallback(async (): Promise<boolean> => {
    const gen = generation.current
    setLoadingMore(true)
    setLoadError(null)
    try {
      const params = new URLSearchParams(searchQuery)
      params.set('page', String(nextPage))
      const res = await fetch(`/api/search/more?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { clinics?: DirectoryClinic[] }
      if (gen !== generation.current) return false
      const rows = Array.isArray(json.clinics) ? json.clinics : []
      // Fewer than a full page means this was the last one.
      if (rows.length < pageSize) setExhausted(true)
      if (rows.length === 0) return false
      setExtra((prev) => [...prev, ...rows])
      setNextPage((p) => p + 1)
      return true
    } catch {
      if (gen === generation.current) setLoadError('Could not load more clinics. Please try again.')
      return false
    } finally {
      if (gen === generation.current) setLoadingMore(false)
    }
  }, [searchQuery, nextPage, pageSize])

  /** Navigate to the current url with `edit` applied, showing the skeleton until it lands. */
  function navigate(edit: (params: URLSearchParams) => void, mode: 'push' | 'replace') {
    const current = window.location.search.replace(/^\?/, '')
    const params = new URLSearchParams(current)
    edit(params)
    const next = params.toString()
    // No change means no navigation, and a skeleton would never clear.
    if (next !== current) setPending(true)
    const href = next ? `/search?${next}` : '/search'
    if (mode === 'push') router.push(href)
    else router.replace(href, { scroll: false })
  }

  function handleLocationChange(stateCode: string, city: string) {
    setSelectedState(stateCode)
    setSelectedCity(city)
    // From the current url, so the query and the listing filters survive a
    // change of state or city. This used to rebuild the url from `q` alone and
    // silently dropped every filter.
    navigate((params) => {
      params.delete('state')
      params.delete('city')
      if (stateCode) params.set('state', stateCode)
      if (city) params.set('city', city)
    }, 'push')
  }

  function clearListingFilters() {
    navigate((params) => LISTING_FILTER_KEYS.forEach((key) => params.delete(key)), 'replace')
  }

  return (
    <div className="md:flex md:items-start md:gap-6">
      <ListingFilters
        items={allClinics}
        mode="clinics"
        resultCount={visibleCount}
        totalCount={totalCount}
        onChange={handleFiltersChange}
        brandOptions={brandOptions}
        serviceOptions={serviceOptions}
        serverFiltered
        countsPending={pending}
        // A search with a place measures Distance from it. undefined, not
        // null, for one without: the panel then looks up the visitor itself,
        // as every other listing's panel does.
        geo={distanceOrigin ?? undefined}
        autoRadius={appliedRadiusMiles}
        anyDistanceParam
        distanceResetKey={searchIdentity(searchQuery)}
      />
      <div className="min-w-0 flex-1">
        {stateOptions.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-3 items-center mb-5 pb-5 border-b border-border">
            <LocationFilterBar
              stateOptions={stateOptions}
              selectedState={selectedState}
              selectedCity={selectedCity}
              onLocationChange={handleLocationChange}
            />
          </div>
        )}
        {pending ? (
          <ClinicCardSkeletonGrid />
        ) : allClinics.length === 0 && filtersActive ? (
          <div className="text-center py-16">
            <p className="text-body text-ink-secondary">No clinics match these filters.</p>
            <button
              type="button"
              className="mt-4 text-brand-accent text-body-sm underline"
              onClick={clearListingFilters}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <ClinicResults
            // A new search starts its reveal window from the top again.
            key={searchQuery}
            clinics={allClinics}
            totalCount={totalCount}
            canLoadMore={canLoadMore}
            onLoadMore={loadMore}
            loadingMore={loadingMore}
            loadError={loadError}
            onVisibleChange={setVisibleCount}
            showDistance={sortedByDistance}
          />
        )}
      </div>
    </div>
  )
}
