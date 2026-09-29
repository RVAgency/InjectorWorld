'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  DEFAULT_LISTING_FILTERS,
  PRICE_MAX,
  PRICE_MIN,
  getActiveListingFilterCount,
  getListingBrandIds,
  getListingClinicType,
  getListingLoyaltyPrograms,
  getListingServiceIds,
  type ListingFilterValues,
} from './applyListingFilters'

type FilterOption = { id: string; name: string }

// Must contain every rung of NEAR_ME_RADIUS_LADDER (lib/merit.ts), or the
// Distance control cannot show the radius the near-me listing is applying.
// 1 and 2 miles added 2026-09-29 (founder). The servers already accept any
// radius, so only this list changed; the near-me default is still 3.
const RADIUS_OPTIONS = [1, 2, 3, 5, 10, 25, 50]
const RATING_OPTIONS = [
  { value: null, label: 'All' },
  { value: 4.5, label: '4.5+' },
  { value: 4, label: '4+' },
  { value: 3.5, label: '3.5+' },
]
const CLINIC_TYPES = ['medspa', 'dermatology', 'plastic-surgery', 'dental-aesthetics', 'other']
const LOYALTY_PROGRAMS = ['alle', 'aspire', 'xperience']
const FILTER_KEYS = ['radius', 'rating', 'virtual', 'priceMin', 'priceMax', 'lang', 'type', 'loyalty', 'brand', 'svc', 'lat', 'lng']

/* LANGUAGE_LABELS lived here until 2026-08-07, alongside the language filter. */

const CLINIC_TYPE_LABELS: Record<string, string> = {
  medspa: 'Med Spa',
  dermatology: 'Dermatology',
  'plastic-surgery': 'Plastic Surgery',
  'dental-aesthetics': 'Dental Aesthetics',
  other: 'Other',
}

const LOYALTY_LABELS: Record<string, string> = {
  alle: 'All\u0113',
  aspire: 'Aspire',
  xperience: 'Xperience',
}

function parseNumber(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseList(value: string | null): string[] {
  return value ? value.split(',').map((v) => v.trim()).filter(Boolean) : []
}

function parseFilters(
  params: URLSearchParams,
  fallbackCoords: { lat: number; lng: number } | null,
  radiusOptions: readonly number[] = RADIUS_OPTIONS,
): ListingFilterValues {
  const radius = parseNumber(params.get('radius'))
  const rating = parseNumber(params.get('rating'))
  const priceMin = parseNumber(params.get('priceMin'))
  const priceMax = parseNumber(params.get('priceMax'))
  const lat = parseNumber(params.get('lat')) ?? fallbackCoords?.lat ?? null
  const lng = parseNumber(params.get('lng')) ?? fallbackCoords?.lng ?? null

  return {
    radius: radius && radiusOptions.includes(radius) ? radius : null,
    anyDistance: params.get('radius') === 'any',
    rating: rating && [3.5, 4, 4.5].includes(rating) ? rating : null,
    virtual: params.get('virtual') === '1',
    priceMin: priceMin ?? PRICE_MIN,
    priceMax: priceMax ?? PRICE_MAX,
    languages: parseList(params.get('lang')),
    clinicTypes: parseList(params.get('type')),
    loyaltyPrograms: parseList(params.get('loyalty')),
    brands: parseList(params.get('brand')),
    services: parseList(params.get('svc')),
    lat,
    lng,
  }
}

function formatCount(count: number): string {
  return count.toLocaleString()
}

/** Honest results label. When filters are applied and the server total exceeds
 * what's been loaded client-side, disambiguates "matches in what's loaded" from
 * the real total so the count never implies we searched the whole dataset. */
/**
 * Where the filter runs decides what this line can honestly claim.
 *
 * Server-backed listings re-query on every filter change, so totalCount is the
 * real number of matches and the plain wording is true. The listings that still
 * filter in the browser only ever searched the rows already loaded, so saying
 * "3 of 225" there implied all 225 were considered when 24 were in memory.
 */
function formatResultsLabel(
  resultCount: number,
  loadedCount: number,
  totalCount: number,
  appliedFilterCount: number,
  serverFiltered: boolean,
): string {
  if (!serverFiltered && appliedFilterCount > 0 && totalCount > loadedCount) {
    return `${formatCount(resultCount)} of the ${formatCount(loadedCount)} loaded so far match. Load more to filter the full ${formatCount(totalCount)}.`
  }
  return `Showing ${formatCount(resultCount)} of ${formatCount(totalCount)} results`
}

/* uniqueSorted lived here until 2026-08-07; it only built the language option
   list, and that filter is gone. */

type ListingFiltersProps<T> = {
  items: T[]
  onChange: (filters: ListingFilterValues) => void
  resultCount: number
  totalCount: number
  mode?: 'providers' | 'clinics' | 'mixed'
  className?: string
  brandOptions?: FilterOption[]
  serviceOptions?: FilterOption[]
  /**
   * Set by listings that re-query the server when a filter changes (2026-08-07).
   * Those can offer every option and report a true total, because the filter
   * runs in SQL across the whole set. Listings without it still filter in the
   * browser over the loaded page, so they only offer what that page contains.
   */
  serverFiltered?: boolean
  /**
   * Coordinates the PAGE resolved, on listings that own geo themselves (the
   * three near-me pillars). Passing it, including as null, stops this panel
   * making its own /api/geo/ip request: a second answer arriving here changed
   * the filter key and fired a second page-1 fetch, which is the second load
   * the visitor was not supposed to see. Omit it and the old behaviour stands,
   * which is what every other listing still needs.
   * See docs/LISTING-FIX-PLAN-2026-09-19.md TASK 3.
   */
  geo?: { lat: number; lng: number } | null
  /**
   * True while the listing is re-querying and the grid is a skeleton. The
   * result line then shows its own placeholder rather than a count that
   * describes rows nobody can see.
   */
  countsPending?: boolean
  /**
   * Radius the PAGE is applying on its own (the near-me default and its wider
   * rungs). Shown in the Distance control so the panel stops reading
   * "Any distance" beside a list filtered to 10 miles. Never written to the
   * URL: only an explicit action here may do that.
   */
  autoRadius?: number | null
  /**
   * Fired when the visitor applies or clears the panel. A number or null is
   * their explicit choice and the page must stop supplying autoRadius; null
   * specifically means "Any distance", which is unreachable otherwise because
   * the page would immediately re-apply its default. 'auto' means Clear all was
   * pressed and the page's default comes back.
   */
  onDistanceChoice?: (choice: number | null | 'auto') => void
  /**
   * Write an explicit "Any distance" to the url as `radius=any` (2026-09-29).
   * Only /search sets it: there the page reads Distance from the url, and on a
   * ZIP search "Any distance" has to differ from no choice (which is the ZIP's
   * 3 miles). The pillar pages keep that choice in onDistanceChoice instead.
   */
  anyDistanceParam?: boolean
  /**
   * Changes when the page starts a different search. The Distance control then
   * goes back to showing what the new search applies, instead of an earlier
   * search's choice (/search keeps this panel mounted across searches).
   */
  distanceResetKey?: string
}

type FilterPanelProps = {
  draft: ListingFilterValues
  setDraft: (filters: ListingFilterValues) => void
  showClinicType: boolean
  showLoyalty: boolean
  hasCoords: boolean
  activeCount: number
  appliedFilterCount: number
  loadedCount: number
  resultCount: number
  totalCount: number
  onApply: () => void
  onClear: () => void
  compact?: boolean
  brandOptions?: FilterOption[]
  serviceOptions?: FilterOption[]
  serverFiltered: boolean
  countsPending: boolean
  autoRadius: number | null
  /** Miles the Distance control offers. */
  radiusOptions: readonly number[]
  /** Called when the visitor moves the Distance control. See section 4.10. */
  onRadiusTouched: () => void
  /** True once the visitor has moved Distance themselves. See section 4.11. */
  radiusTouched: boolean
}

export function ListingFilters<T>(props: ListingFiltersProps<T>) {
  return (
    <Suspense
      fallback={
        <ListingFiltersFallback
          className={props.className}
          resultCount={props.resultCount}
          totalCount={props.totalCount}
        />
      }
    >
      <ListingFiltersInner {...props} />
    </Suspense>
  )
}

function ListingFiltersInner<T>({
  items,
  onChange,
  resultCount,
  totalCount,
  mode = 'mixed',
  className,
  brandOptions,
  serviceOptions,
  serverFiltered = false,
  geo,
  countsPending = false,
  autoRadius = null,
  onDistanceChoice,
  anyDistanceParam = false,
  distanceResetKey,
}: ListingFiltersProps<T>) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  /**
   * `geo` present, even as null, means the page owns geo and this panel must
   * not run its own lookup. Absent means every other listing keeps today's
   * behaviour exactly. See docs/LISTING-FIX-PLAN-2026-09-19.md TASK 3.4.
   *
   * Deliberate and out of scope (TASK 3.10 item 2): the state, city and
   * service-city listings pass no `geo`, so they still make this call and still
   * fire one wasted page-1 re-query when it answers, now returning the same
   * rows. Fixing that means stopping bare coordinates from travelling when no
   * radius is set, which changes toServerFilterParams and would reach the three
   * pillar pages that need bare coordinates as a sort origin. Its own round.
   * Do not start it here.
   */
  const pageOwnsGeo = geo !== undefined
  const [geoCoords, setGeoCoords] = useState<{ lat: number; lng: number } | null>(null)
  /**
   * Rebuilt from the two NUMBERS rather than taken from the prop object.
   *
   * The three pillar listings pass `geo` as an inline object literal, so it is
   * a new identity on every one of their renders. Feeding that straight into
   * the memo below made `filters` new on every render, and the
   * `onChange(filters)` effect then set the page's filter state to a new
   * object, which re-rendered the page, which built another `geo` literal.
   * That is an infinite render loop and React ends it by throwing "Maximum
   * update depth exceeded". Keying on the numbers means the identity changes
   * only when the coordinates actually change, whatever the caller passes.
   * See docs/LISTING-FIX-PLAN-2026-09-19.md section 3.11.
   */
  const geoLat = geo?.lat ?? null
  const geoLng = geo?.lng ?? null
  const coords = useMemo(
    () =>
      pageOwnsGeo
        ? geoLat != null && geoLng != null
          ? { lat: geoLat, lng: geoLng }
          : null
        : geoCoords,
    [pageOwnsGeo, geoLat, geoLng, geoCoords],
  )
  /**
   * RADIUS_OPTIONS, plus the page's own radius when it is not one of them
   * (/search's place-name fallback reaches 60 miles), so the control can show
   * it rather than fall back to reading "Any distance".
   */
  const radiusOptions = useMemo(
    () =>
      autoRadius != null && autoRadius > 0 && !RADIUS_OPTIONS.includes(autoRadius)
        ? [...RADIUS_OPTIONS, autoRadius].sort((a, b) => a - b)
        : RADIUS_OPTIONS,
    [autoRadius],
  )
  const filters = useMemo(
    () => parseFilters(searchParams, coords, radiusOptions),
    [searchParams, coords, radiusOptions],
  )
  const [draft, setDraft] = useState<ListingFilterValues>(filters)
  const [sheetOpen, setSheetOpen] = useState(false)

  /**
   * Only offer brands and services that at least one loaded clinic actually
   * carries. Filtering runs in the browser over the page that is in memory
   * (24 rows), so offering all 200 brands meant most choices returned zero and
   * looked broken. Server-side filtering is the real fix and comes next; until
   * then the menu tells the truth about what it can find.
   */
  const availableBrandOptions = useMemo(() => {
    if (!brandOptions || serverFiltered) return brandOptions
    const present = new Set(items.flatMap((item) => getListingBrandIds(item)))
    return brandOptions.filter((o) => present.has(String(o.id)))
  }, [brandOptions, items, serverFiltered])

  const availableServiceOptions = useMemo(() => {
    if (!serviceOptions || serverFiltered) return serviceOptions
    const present = new Set(items.flatMap((item) => getListingServiceIds(item)))
    return serviceOptions.filter((o) => present.has(String(o.id)))
  }, [serviceOptions, items, serverFiltered])

  const hasClinicTypes = useMemo(
    () => items.some((item) => Boolean(getListingClinicType(item))),
    [items],
  )

  const hasLoyalty = useMemo(
    () => items.some((item) => getListingLoyaltyPrograms(item).length > 0),
    [items],
  )

  /**
   * Set when the visitor changes the Distance control themselves.
   *
   * Without it, writeFilters reported `radius: null` on EVERY Apply, so ticking
   * a rating or a brand told the page the visitor had chosen "Any distance" and
   * the near-me radius was dropped. Measured on staging: /clinics went from
   * "307 clinics within 10 miles" to a national 17,364 on one rating tick.
   * See docs/LISTING-FIX-PLAN-2026-09-19.md section 4.10.
   */
  const [radiusTouched, setRadiusTouched] = useState(false)
  // A new search starts with Distance showing what that search applies.
  useEffect(() => setRadiusTouched(false), [distanceResetKey])

  const activeCount = getActiveListingFilterCount(filters)
  const draftActiveCount = getActiveListingFilterCount(draft)
  const urlHasCoords = searchParams.has('lat') && searchParams.has('lng')
  const hasCoords = filters.lat != null && filters.lng != null

  useEffect(() => setDraft(filters), [filters])
  useEffect(() => onChange(filters), [filters, onChange])

  useEffect(() => {
    /**
     * Deliberate side effect on the three pillar pages (2026-09-19, TASK 3.10
     * item 1): with the page owning geo, the Distance control is enabled by
     * `hasCoords`, which now waits for useNearMe to reach 'ready' and stays
     * disabled permanently for a visitor it could not locate. That is correct.
     * Before this, a non-US visitor got a Distance control powered by
     * coordinates in another country. The way back in is the Set your ZIP
     * control, which sets a real US point and enables Distance.
     */
    if (pageOwnsGeo || urlHasCoords || geoCoords) return
    const controller = new AbortController()
    fetch('/api/geo/ip', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (typeof data?.lat === 'number' && typeof data?.lng === 'number') {
          setGeoCoords({ lat: data.lat, lng: data.lng })
        }
      })
      .catch(() => {})
    return () => controller.abort()
  }, [geoCoords, urlHasCoords, pageOwnsGeo])

  useEffect(() => {
    if (!sheetOpen) return
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [sheetOpen])

  function writeFilters(next: ListingFilterValues) {
    const params = new URLSearchParams(searchParams.toString())
    FILTER_KEYS.forEach((key) => params.delete(key))

    if (next.radius != null) params.set('radius', String(next.radius))
    else if (anyDistanceParam && next.anyDistance) params.set('radius', 'any')
    if (next.rating != null) params.set('rating', String(next.rating))
    if (next.virtual) params.set('virtual', '1')
    if (next.priceMin !== PRICE_MIN) params.set('priceMin', String(next.priceMin))
    if (next.priceMax !== PRICE_MAX) params.set('priceMax', String(next.priceMax))
    if (next.languages.length > 0) params.set('lang', next.languages.join(','))
    if (next.clinicTypes.length > 0) params.set('type', next.clinicTypes.join(','))
    if (next.loyaltyPrograms.length > 0) params.set('loyalty', next.loyaltyPrograms.join(','))
    if (next.brands.length > 0) params.set('brand', next.brands.join(','))
    if (next.services.length > 0) params.set('svc', next.services.join(','))

    const shouldWriteCoords = urlHasCoords || next.radius != null
    if (shouldWriteCoords && next.lat != null && next.lng != null) {
      params.set('lat', String(Number(next.lat.toFixed(5))))
      params.set('lng', String(Number(next.lng.toFixed(5))))
    }

    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    // Only when the visitor moved the Distance control themselves. Reporting on
    // every Apply told the page that ticking a rating meant "Any distance", and
    // the near-me radius was silently dropped. See section 4.10.
    if (radiusTouched) onDistanceChoice?.(next.radius)
    onChange(next)
    setSheetOpen(false)
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams.toString())
    FILTER_KEYS.forEach((key) => params.delete(key))
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    const cleared = { ...DEFAULT_LISTING_FILTERS, lat: coords?.lat ?? null, lng: coords?.lng ?? null }
    setDraft(cleared)
    // Clear all hands Distance back to the page, so its near-me default returns.
    setRadiusTouched(false)
    onDistanceChoice?.('auto')
    onChange(cleared)
    setSheetOpen(false)
  }

  const panel = (
    <FilterPanel
      draft={draft}
      setDraft={setDraft}
      showClinicType={mode !== 'providers' && (hasClinicTypes || mode === 'clinics')}
      showLoyalty={mode !== 'clinics' && (hasLoyalty || mode === 'providers')}
      hasCoords={hasCoords}
      activeCount={draftActiveCount}
      appliedFilterCount={activeCount}
      loadedCount={items.length}
      resultCount={resultCount}
      totalCount={totalCount}
      onApply={() => writeFilters(draft)}
      onClear={clearFilters}
      brandOptions={availableBrandOptions}
      serviceOptions={availableServiceOptions}
      serverFiltered={serverFiltered}
      countsPending={countsPending}
      autoRadius={autoRadius}
      radiusOptions={radiusOptions}
      onRadiusTouched={() => setRadiusTouched(true)}
      radiusTouched={radiusTouched}
    />
  )

  return (
    <>
      <aside className={`hidden md:block md:w-[280px] md:flex-shrink-0 ${className ?? ''}`}>
        <div className="sticky top-24 rounded-xl border border-border bg-surface-canvas p-4 shadow-sm">
          {panel}
        </div>
      </aside>

      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        className="fixed bottom-4 left-4 right-4 z-40 md:hidden flex items-center justify-center gap-2 rounded-control bg-brand-primary text-surface-canvas px-5 py-3 text-body-sm font-semibold shadow-lg"
      >
        Filters
        {activeCount > 0 && (
          <span className="inline-flex min-w-5 h-5 items-center justify-center rounded-full bg-brand-accent text-white text-[11px]">
            {activeCount}
          </span>
        )}
      </button>

      {sheetOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Listing filters">
          <button
            type="button"
            aria-label="Close filters"
            onClick={() => setSheetOpen(false)}
            className="absolute inset-0 bg-black/45"
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface-canvas p-5 shadow-lg">
            <FilterPanel
              draft={draft}
              setDraft={setDraft}
              showClinicType={mode !== 'providers' && (hasClinicTypes || mode === 'clinics')}
      showLoyalty={mode !== 'clinics' && (hasLoyalty || mode === 'providers')}
              hasCoords={hasCoords}
              activeCount={draftActiveCount}
              appliedFilterCount={activeCount}
              loadedCount={items.length}
              resultCount={resultCount}
              totalCount={totalCount}
              onApply={() => writeFilters(draft)}
              onClear={clearFilters}
              compact
              brandOptions={availableBrandOptions}
              serviceOptions={availableServiceOptions}
              serverFiltered={serverFiltered}
              countsPending={countsPending}
              autoRadius={autoRadius}
              radiusOptions={radiusOptions}
              onRadiusTouched={() => setRadiusTouched(true)}
              radiusTouched={radiusTouched}
            />
          </div>
        </div>
      )}
    </>
  )
}

function ListingFiltersFallback({
  className,
  resultCount,
  totalCount,
}: {
  className?: string
  resultCount: number
  totalCount: number
}) {
  return (
    <>
      <aside className={`hidden md:block md:w-[280px] md:flex-shrink-0 ${className ?? ''}`}>
        <div className="sticky top-24 rounded-xl border border-border bg-surface-canvas p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-h4 text-ink-primary">Filters</h2>
              <p className="text-caption text-ink-tertiary mt-1">
                Showing {formatCount(resultCount)} of {formatCount(totalCount)} results
              </p>
            </div>
          </div>
          <div className="mt-5 space-y-3">
            <div className="h-9 rounded-lg bg-surface animate-pulse" />
            <div className="h-20 rounded-lg bg-surface animate-pulse" />
            <div className="h-9 rounded-lg bg-surface animate-pulse" />
          </div>
        </div>
      </aside>
      <button
        type="button"
        disabled
        className="fixed bottom-4 left-4 right-4 z-40 md:hidden flex items-center justify-center gap-2 rounded-control bg-brand-primary text-surface-canvas px-5 py-3 text-body-sm font-semibold shadow-lg opacity-70"
      >
        Filters
      </button>
    </>
  )
}

function FilterPanel({
  draft,
  setDraft,
  showClinicType,
  showLoyalty,
  hasCoords,
  activeCount,
  appliedFilterCount,
  loadedCount,
  resultCount,
  totalCount,
  onApply,
  onClear,
  compact = false,
  brandOptions,
  serviceOptions,
  serverFiltered,
  countsPending,
  autoRadius,
  radiusOptions,
  onRadiusTouched,
  radiusTouched,
}: FilterPanelProps) {
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-h4 text-ink-primary">Filters</h2>
          {countsPending ? (
            <span className="mt-1 block h-4 w-40 rounded-control bg-surface animate-pulse" />
          ) : (
            <p className="text-caption text-ink-tertiary mt-1">
              {formatResultsLabel(resultCount, loadedCount, totalCount, appliedFilterCount, serverFiltered)}
            </p>
          )}
        </div>
        {activeCount > 0 && (
          <span className="rounded-control bg-brand-accent-soft px-2.5 py-1 text-caption font-semibold text-brand-accent">
            {activeCount}
          </span>
        )}
      </div>

      <Field label="Distance">
        <select
          // Before the visitor touches Distance, show what the PAGE is
          // applying. After they touch it, show exactly what they picked, or
          // "Any distance" snaps back to the page's radius and reads as a
          // broken option. See docs/LISTING-FIX-PLAN-2026-09-19.md 4.11.
          // An "Any distance" carried in the url (radius=any) is shown as
          // exactly that too.
          value={
            radiusTouched || draft.anyDistance
              ? (draft.radius ?? '')
              : (draft.radius ?? autoRadius ?? '')
          }
          disabled={!hasCoords}
          onChange={(e) => {
            // Marks Distance as the visitor's own choice, so an Apply that only
            // changed a rating or a brand no longer reports "Any distance" and
            // silently drops the near-me radius. See section 4.10.
            onRadiusTouched()
            setDraft({
              ...draft,
              radius: e.target.value ? Number(e.target.value) : null,
              anyDistance: !e.target.value,
            })
          }}
          className="w-full rounded-lg border border-border bg-surface-canvas px-3 py-2 text-body-sm text-ink-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">Any distance</option>
          {radiusOptions.map((radius) => (
            <option key={radius} value={radius}>{radius} mi</option>
          ))}
        </select>
        {!hasCoords && (
          <p className="mt-2 text-caption text-ink-tertiary">
            <Link href="/search" className="text-brand-accent hover:underline">Set your location</Link> to use distance.
          </p>
        )}
      </Field>

      <Field label="Rating">
        <div className="grid grid-cols-2 gap-2">
          {RATING_OPTIONS.map((option) => (
            <label
              key={option.label}
              className={`flex cursor-pointer items-center justify-center rounded-lg border px-3 py-2 text-body-sm transition ${
                draft.rating === option.value
                  ? 'border-brand-primary bg-brand-primary text-surface-canvas'
                  : 'border-border bg-surface-canvas text-ink-secondary hover:border-brand-accent'
              }`}
            >
              <input
                type="radio"
                name="listing-rating"
                value={option.value ?? ''}
                checked={draft.rating === option.value}
                onChange={() => setDraft({ ...draft, rating: option.value })}
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </div>
      </Field>

      {/* Price range, Languages and "Virtual consult available" were removed
          from this panel on 2026-08-07. All three had nothing to filter on:
          across 39,669 published clinics, starting_price is null on every row
          and clinics_languages holds zero rows. The underlying serviceType,
          yearEstablished, acceptsNewPatients, offersVirtualConsult and
          languages columns on Clinics were dropped entirely on 2026-08-23 --
          those are not coming back without a new data source. clinicType
          (this "Clinic type" filter) is unrelated and kept: it is a real,
          populated field (medspa/dermatology/plastic-surgery/...). */}

      {showClinicType && (
        <MultiSelect
          label="Clinic type"
          values={draft.clinicTypes}
          options={CLINIC_TYPES}
          labels={CLINIC_TYPE_LABELS}
          onChange={(clinicTypes) => setDraft({ ...draft, clinicTypes })}
        />
      )}

      {showLoyalty && (
        <MultiSelect
          label="Loyalty programs"
          values={draft.loyaltyPrograms}
          options={LOYALTY_PROGRAMS}
          labels={LOYALTY_LABELS}
          onChange={(loyaltyPrograms) => setDraft({ ...draft, loyaltyPrograms })}
        />
      )}

      {brandOptions && brandOptions.length > 0 && (
        <MultiSelectOptions
          label="Brand"
          values={draft.brands}
          options={brandOptions}
          onChange={(brands) => setDraft({ ...draft, brands })}
        />
      )}

      {serviceOptions && serviceOptions.length > 0 && (
        <MultiSelectOptions
          label="Service"
          values={draft.services}
          options={serviceOptions}
          onChange={(services) => setDraft({ ...draft, services })}
        />
      )}

      <div className={`${compact ? 'sticky bottom-0 -mx-5 bg-surface-canvas px-5 pb-1 pt-4' : ''} flex gap-2`}>
        <button
          type="button"
          onClick={onClear}
          className="flex-1 rounded-control border border-border px-4 py-2.5 text-body-sm font-semibold text-ink-secondary hover:border-brand-accent hover:text-ink-primary"
        >
          Clear all
        </button>
        <button
          type="button"
          onClick={onApply}
          className="flex-1 rounded-control bg-brand-primary px-4 py-2.5 text-body-sm font-semibold text-surface-canvas hover:opacity-90"
        >
          {/* "Show 24 results" promised a preview of what the unapplied draft
              would return. That number cannot be known without running the
              query, and 24 was simply the page size. The count this panel CAN
              state honestly is already directly above, in formatResultsLabel. */}
          {compact ? 'Apply filters' : 'Apply'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-2 block text-caption font-semibold uppercase tracking-wider text-ink-tertiary">{label}</label>
      {children}
    </div>
  )
}

function MultiSelectOptions({
  label,
  values,
  options,
  onChange,
}: {
  label: string
  values: string[]
  options: FilterOption[]
  onChange: (values: string[]) => void
}) {
  return (
    <Field label={label}>
      <details className="group rounded-lg border border-border bg-surface-canvas">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-body-sm text-ink-primary">
          <span>{values.length ? `${values.length} selected` : `Any ${label.toLowerCase()}`}</span>
          <svg className="h-4 w-4 text-ink-tertiary transition group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </summary>
        <div className="max-h-48 overflow-y-auto border-t border-border p-2">
          {options.map((opt) => {
            const checked = values.includes(opt.id)
            return (
              <label key={opt.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-body-sm text-ink-secondary hover:bg-surface">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    onChange(
                      e.target.checked
                        ? [...values, opt.id]
                        : values.filter((v) => v !== opt.id),
                    )
                  }}
                  className="h-4 w-4 accent-brand-accent"
                />
                {opt.name}
              </label>
            )
          })}
        </div>
      </details>
    </Field>
  )
}

function MultiSelect({
  label,
  values,
  options,
  labels,
  emptyLabel,
  onChange,
}: {
  label: string
  values: string[]
  options: string[]
  labels: Record<string, string>
  emptyLabel?: string
  onChange: (values: string[]) => void
}) {
  return (
    <Field label={label}>
      <details className="group rounded-lg border border-border bg-surface-canvas">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-body-sm text-ink-primary">
          <span>{values.length ? `${values.length} selected` : `Any ${label.toLowerCase()}`}</span>
          <svg className="h-4 w-4 text-ink-tertiary transition group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </summary>
        <div className="max-h-48 overflow-y-auto border-t border-border p-2">
          {options.length === 0 ? (
            <p className="px-1 py-2 text-caption text-ink-tertiary">{emptyLabel ?? 'No options available'}</p>
          ) : (
            options.map((option) => {
              const checked = values.includes(option)
              return (
                <label key={option} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-body-sm text-ink-secondary hover:bg-surface">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      onChange(
                        e.target.checked
                          ? [...values, option]
                          : values.filter((value) => value !== option),
                      )
                    }}
                    className="h-4 w-4 accent-brand-accent"
                  />
                  {labels[option] ?? option}
                </label>
              )
            })
          )}
        </div>
      </details>
    </Field>
  )
}
