'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { rememberListing } from '@/lib/from-listing'
import { DirectoryClinicCard } from '@/components/shared/DirectoryClinicCard'
import { ClinicCardSkeleton, ClinicCardSkeletonGrid } from '@/components/shared/ClinicCardSkeletonGrid'
import { ListingFilters } from '@/components/shared/ListingFilters'
import {
  DEFAULT_LISTING_FILTERS,
  applyListingFilters,
  serverFilterKey,
  toServerFilterParams,
  type ListingFilterValues,
} from '@/components/shared/applyListingFilters'
import { CountPill } from '@/components/shared/CountPill'
import { FaqBlock } from '@/components/faq/FaqBlock'
import type { CityHubData } from '@/lib/location-queries'
import { distinctNeighborhoods, matchesNeighborhood } from '@/lib/neighborhood-filter'

const CLINIC_PAGE_SIZE = 24

type Props = { data: CityHubData; schema: object[] }

export function CityHubPage({ data, schema }: Props) {
  const { city, stateLocation, services: treatments, brands, clinics, neighborhoods, faqs, totalClinics, allClinicLinks } = data
  const cityDisplay = city.name.replace(/\s+city$/i, '')
  const pathname = usePathname()
  const duplicateNames = useMemo(() => {
    const seen = new Map<string, number>()
    for (const c of allClinicLinks) {
      const k = c.name.trim().toLowerCase()
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k))
  }, [allClinicLinks])
  const [neighborhood, setNeighborhood] = useState('')
  const [listingFilters, setListingFilters] = useState<ListingFilterValues>(DEFAULT_LISTING_FILTERS)
  const [allClinics, setAllClinics] = useState(clinics)
  const [clinicPage, setClinicPage] = useState(1)
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
  const isClinicLoading = fetchPhase !== 'idle'
  const [clinicLoadError, setClinicLoadError] = useState<string | null>(null)
  const [serverTotal, setServerTotal] = useState(totalClinics)

  // Server order, kept. The listing API and the server-rendered first page run
  // one query with one total order (has_photo, review count NULLS LAST,
  // created_at, id), so re-sorting here with a different merit proxy would
  // discard that and shuffle page 2 into page 1. Filtering preserves order.
  const listingClinics = useMemo(
    () => applyListingFilters(allClinics, listingFilters, 'clinic').items,
    [allClinics, listingFilters],
  )
  const filteredClinics = useMemo(
    () => listingClinics.filter((c) => matchesNeighborhood(c.neighborhood, neighborhood)),
    [listingClinics, neighborhood],
  )
  const neighborhoodOptions = useMemo(
    () => distinctNeighborhoods([
      ...neighborhoods.map((n) => n.name),
      ...allClinics.map((c) => c.neighborhood),
    ]),
    [allClinics, neighborhoods],
  )

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
    setAllClinics(clinics)
    setClinicPage(1)
    setClinicLoadError(null)
    setServerTotal(totalClinics)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city.slug])

  const hasMoreClinics = fetchPhase !== 'replacing' && allClinics.length < serverTotal
  const remainingClinics = Math.max(0, serverTotal - allClinics.length)

  async function fetchClinicPage(nextPage: number, append: boolean) {
    if (!stateLocation) return

    setFetchPhase(append ? 'appending' : 'replacing')
    setClinicLoadError(null)

    try {
      const params = new URLSearchParams({
        stateSlug: stateLocation.slug,
        citySlug: city.slug,
        page: String(nextPage),
        limit: String(CLINIC_PAGE_SIZE),
      })
      // Brand / service / clinic type / rating are resolved server-side as of
      // 2026-08-07, so totalDocs is the real match count for the filters.
      toServerFilterParams(listingFilters).forEach((value, key) => params.set(key, value))

      const res = await fetch(`/api/city-clinics?${params.toString()}`)
      if (!res.ok) throw new Error('Unable to load more clinics.')

      const json = await res.json() as { clinics?: CityHubData['clinics']; totalDocs?: number }
      const nextClinics = Array.isArray(json.clinics) ? json.clinics : []

      setAllClinics((prev) => {
        if (!append) return nextClinics
        const seen = new Set(prev.map((clinic) => clinic.id))
        return [...prev, ...nextClinics.filter((clinic) => !seen.has(clinic.id))]
      })
      if (typeof json.totalDocs === 'number') setServerTotal(json.totalDocs)
      setClinicPage(nextPage)
    } catch {
      setClinicLoadError('Could not load more clinics. Please try again.')
    } finally {
      setFetchPhase('idle')
    }
  }

  async function loadMoreClinics() {
    if (isClinicLoading || !hasMoreClinics) return
    await fetchClinicPage(clinicPage + 1, true)
  }

  // Re-query from page 1 when a server-handled filter changes. The ref holds
  // the last key actually fetched, so the server-rendered first page is not
  // re-requested on mount.
  const serverKey = serverFilterKey(listingFilters)
  const appliedServerKey = useRef(serverKey)
  useEffect(() => {
    if (appliedServerKey.current === serverKey) return
    appliedServerKey.current = serverKey
    void fetchClinicPage(1, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey])

  return (
    <>
      {schema.map((s, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(s).replace(/</g, '\\u003c') }} />
      ))}

      {/* Breadcrumb */}
      <div className="bg-surface border-b border-border">
        <div className="max-canvas py-3">
          {/* The Clinics crumb matches the JSON-LD BreadcrumbList this page
              renders, and the url it now sits on. Google expects the markup to
              describe the visible trail, so these two must not drift apart. */}
          <nav className="flex items-center gap-2 text-caption text-ink-tertiary flex-wrap" aria-label="Breadcrumb">
            <Link href="/" className="hover:text-ink-primary transition">Home</Link>
            <span>/</span>
            <Link href="/clinics" className="hover:text-ink-primary transition">Clinics</Link>
            <span>/</span>
            {stateLocation && (
              <>
                <Link href={`/clinics/${stateLocation.slug}`} className="hover:text-ink-primary transition">{stateLocation.name}</Link>
                <span>/</span>
              </>
            )}
            <span className="text-ink-primary">{city.name}</span>
          </nav>
        </div>
      </div>

      {/* Hero. Navy on purpose: the clinics path keeps its always-dark band
          (Footer pattern) while borrowing the brand/service hero proportions.
          No picker here, this is the bottom of the tree. */}
      <section className="bg-[#0B1B34] text-white pb-8 pt-8 md:pb-10 md:pt-10">
        <div className="max-canvas max-w-4xl">
          <span className="text-overline uppercase tracking-widest font-semibold text-brand-accent mb-3 block">
            {stateLocation?.name ?? city.stateCode}
          </span>
          <h1 className="font-serif text-h1-m md:text-h1 font-medium leading-tight tracking-tight mb-3">
            Find clinics in {cityDisplay}
          </h1>
          {totalClinics > 0 && (
            <div className="mt-5 flex flex-wrap gap-3">
              {/* The live total of the list below (2026-09-28), not the page's fixed number:
                  it follows the filter panel, and pulses while a re-query runs. */}
              <CountPill count={serverTotal} label="verified aesthetic clinics" pending={fetchPhase === 'replacing'} />
            </div>
          )}
        </div>
      </section>

      <div className="section-pad bg-surface-canvas">
        <div className="max-canvas space-y-14">
          <div className="md:flex md:items-start md:gap-6">
            <ListingFilters
              items={allClinics}
              mode="clinics"
              resultCount={filteredClinics.length}
              totalCount={serverTotal}
              onChange={setListingFilters}
              brandOptions={brands.map((b) => ({ id: b.id, name: b.name }))}
              serviceOptions={treatments.map((t) => ({ id: t.id, name: t.name }))}
              serverFiltered
              countsPending={fetchPhase === 'replacing'}
            />

            <div className="min-w-0 flex-1 space-y-14 pb-20 md:pb-0">
              {neighborhoodOptions.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-caption text-ink-tertiary uppercase tracking-wider">Neighborhood</span>
                  <select
                    value={neighborhood}
                    onChange={(e) => setNeighborhood(e.target.value)}
                    className="px-3 py-2 rounded-control border border-border text-body-sm text-ink-primary bg-surface-canvas focus:outline-none focus:border-brand-accent cursor-pointer"
                    aria-label="Filter by neighborhood"
                  >
                    <option value="">All neighborhoods</option>
                    {neighborhoodOptions.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Top Clinics */}
              {fetchPhase === 'replacing' ? (
                // The rows on screen are about to be thrown away, so the
                // skeleton takes their place rather than leaving stale cards
                // under an already-updated count.
                <div>
                  <div className="flex items-baseline justify-between mb-6">
                    <h2 className="font-serif text-h2 text-ink-primary">Top clinics in {cityDisplay}</h2>
                  </div>
                  <ClinicCardSkeletonGrid className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" />
                </div>
              ) : filteredClinics.length > 0 ? (
                <div>
                  <div className="flex items-baseline justify-between mb-6">
                    <h2 className="font-serif text-h2 text-ink-primary">Top clinics in {cityDisplay}</h2>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredClinics.map((c, i) => (
                      <DirectoryClinicCard key={c.id} c={c} priority={i < 3} />
                    ))}
                    {fetchPhase === 'appending' &&
                      Array.from({ length: 6 }).map((_, i) => <ClinicCardSkeleton key={`sk-${i}`} />)}
                  </div>
                  {clinicLoadError && (
                    <p className="mt-4 text-body-sm text-state-error text-center" role="status">
                      {clinicLoadError}
                    </p>
                  )}
                  {hasMoreClinics && (
                    <div className="mt-6 text-center">
                      <button
                        type="button"
                        onClick={loadMoreClinics}
                        disabled={isClinicLoading}
                        className="inline-flex items-center gap-2 px-6 py-3 rounded-control border border-border text-body-sm font-medium text-ink-primary hover:border-brand-accent hover:bg-surface transition disabled:opacity-50"
                      >
                        {isClinicLoading ? 'Loading...' : `Load more clinics (${remainingClinics.toLocaleString()} remaining)`}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-2xl border border-border bg-surface p-8 text-center">
                  <p className="text-body text-ink-secondary">No clinics match your filters.</p>
                  <button
                    type="button"
                    onClick={() => setNeighborhood('')}
                    className="mt-3 text-brand-accent text-body-sm hover:underline"
                  >
                    Clear neighborhood
                  </button>
                </div>
              )}
            </div>
          </div>

          {/*
            Full clinic link index.

            The card grid above stops at 24 rows behind a JS "Load more", so
            every clinic past that point was unreachable by a crawler. This list
            carries the rest. It is rendered unconditionally, never behind an
            accordion or an open state: markup that is not in the served HTML
            does nothing for discovery. Plain text links on purpose, no cards
            and no per-row SVG, which is what keeps 450 rows cheap.
          */}
          {stateLocation && allClinicLinks.length > 1 && (
            <div>
              <h2 className="font-serif text-h3 text-ink-primary mb-5">
                All clinics in {cityDisplay}, {city.stateCode}
              </h2>
              <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2">
                {allClinicLinks.map((c) => (
                  <li key={c.slug}>
                    <Link
                      href={`/clinics/${stateLocation.slug}/${city.slug}/${c.slug}`}
                      // Up to thousands per city: no viewport prefetch
                      // (2026-09-24). Still crawlable, still client-side nav.
                      prefetch={false}
                      onClick={() => rememberListing(pathname, `/clinics/${stateLocation.slug}/${city.slug}/${c.slug}`)}
                      className="text-body-sm text-ink-secondary hover:text-brand-accent transition"
                    >
                      {c.name}
                      {/* Several branches of one chain share a name; the ZIP from
                          the slug (locked format name-zip5) tells them apart
                          (2026-09-25, QA T2-10). */}
                      {duplicateNames.has(c.name.trim().toLowerCase()) && /-(\d{5})$/.test(c.slug)
                        ? ` (${c.slug.slice(-5)})`
                        : ''}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* FAQs: preview only, the full set and its schema live on /faq/<category> */}
          <FaqBlock faqs={faqs} seeAll={data.faqSeeAll} />
        </div>
      </div>
    </>
  )
}
