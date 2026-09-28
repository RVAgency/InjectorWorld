'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import Link from 'next/link'
import { DirectoryClinicCard } from '@/components/shared/DirectoryClinicCard'
import { ClinicCardSkeleton, ClinicCardSkeletonGrid } from '@/components/shared/ClinicCardSkeletonGrid'
import { ListingFilters } from '@/components/shared/ListingFilters'
import { LocationPicker } from '@/components/shared/LocationPicker'
import {
  DEFAULT_LISTING_FILTERS,
  applyListingFilters,
  serverFilterKey,
  toServerFilterParams,
  type ListingFilterValues,
} from '@/components/shared/applyListingFilters'
import { CountPill } from '@/components/shared/CountPill'
import { FaqBlock } from '@/components/faq/FaqBlock'
import type { StateHubData } from '@/lib/location-queries'

type Props = { data: StateHubData; schema: object[] }

export function StateHubPage({ data, schema }: Props) {
  const { state, allCities, services: treatments, brands, clinics, faqs, totalClinics } = data
  const [listingFilters, setListingFilters] = useState<ListingFilterValues>(DEFAULT_LISTING_FILTERS)
  const [allClinics, setAllClinics] = useState(clinics)
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
  const [serverTotal, setServerTotal] = useState(totalClinics)

  // Server order, kept. The listing API and the server-rendered first page run
  // one query with one total order (has_photo, review count NULLS LAST,
  // created_at, id), so re-sorting here with a different merit proxy would
  // discard that and shuffle page 2 into page 1. Filtering preserves order.
  const filteredClinics = useMemo(
    () => applyListingFilters(allClinics, listingFilters, 'clinic').items,
    [allClinics, listingFilters],
  )
  const hasMore = fetchPhase !== 'replacing' && allClinics.length < serverTotal

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
    setPage(1)
    setLoadError(null)
    setServerTotal(totalClinics)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.slug])

  async function fetchPage(nextPage: number, append: boolean) {
    setFetchPhase(append ? 'appending' : 'replacing')
    setLoadError(null)

    try {
      const params = new URLSearchParams({
        stateSlug: state.slug,
        page: String(nextPage),
        limit: '24',
      })
      // Brand / service / clinic type / rating are resolved server-side as of
      // 2026-08-07, so totalDocs is the real match count for the filters.
      toServerFilterParams(listingFilters).forEach((value, key) => params.set(key, value))

      const res = await fetch(`/api/state-clinics?${params.toString()}`)
      if (!res.ok) throw new Error('Unable to load more clinics.')

      const json = await res.json() as { clinics?: StateHubData['clinics']; totalDocs?: number }
      const nextClinics = Array.isArray(json.clinics) ? json.clinics : []

      setAllClinics((prev) => {
        if (!append) return nextClinics
        const seen = new Set(prev.map((clinic) => clinic.id))
        return [...prev, ...nextClinics.filter((clinic) => !seen.has(clinic.id))]
      })
      if (typeof json.totalDocs === 'number') setServerTotal(json.totalDocs)
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
          <nav className="flex items-center gap-2 text-caption text-ink-tertiary" aria-label="Breadcrumb">
            <Link href="/" className="hover:text-ink-primary transition">Home</Link>
            <span>/</span>
            <Link href="/clinics" className="hover:text-ink-primary transition">Clinics</Link>
            <span>/</span>
            <span className="text-ink-primary">{state.name}</span>
          </nav>
        </div>
      </div>

      {/* Hero. Navy on purpose: the clinics path keeps its always-dark band
          (Footer pattern) while borrowing the brand/service hero proportions. */}
      <section className="bg-[#0B1B34] text-white pb-8 pt-8 md:pb-10 md:pt-10">
        <div className="max-canvas max-w-4xl">
          <span className="text-overline uppercase tracking-widest font-semibold text-brand-accent mb-3 block">
            Clinic Directory
          </span>
          <h1 className="font-serif text-h1-m md:text-h1 font-medium leading-tight tracking-tight mb-3">
            Find a clinic in {state.name}
          </h1>
          {totalClinics > 0 && (
            <div className="mt-5 flex flex-wrap gap-3">
              {/* The live total of the list below (2026-09-28), not the page's fixed number:
                  it follows the filter panel, and pulses while a re-query runs. */}
              <CountPill count={serverTotal} label="verified clinics" pending={fetchPhase === 'replacing'} />
            </div>
          )}

          {allCities.length > 0 && (
            <LocationPicker
              states={allCities.map((c) => ({ code: c.slug, name: c.name, slug: c.slug, count: c.clinicCount }))}
              basePath={`/clinics/${state.slug}`}
              label="Select a city"
            />
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
              {/* Top Clinics */}
              {fetchPhase === 'replacing' ? (
                // The rows on screen are about to be thrown away, so the
                // skeleton takes their place rather than leaving stale cards
                // under an already-updated count.
                <div>
                  <h2 className="font-serif text-h2 text-ink-primary mb-6">Top Clinics in {state.name}</h2>
                  <ClinicCardSkeletonGrid />
                </div>
              ) : filteredClinics.length > 0 ? (
                <div>
                  <h2 className="font-serif text-h2 text-ink-primary mb-6">Top Clinics in {state.name}</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
                    {filteredClinics.map((c, i) => (
                      <DirectoryClinicCard key={c.id} c={c} priority={i < 3} />
                    ))}
                    {fetchPhase === 'appending' &&
                      Array.from({ length: 6 }).map((_, i) => <ClinicCardSkeleton key={`sk-${i}`} />)}
                  </div>

                  {loadError && (
                    <p className="mt-4 text-body-sm text-state-error text-center" role="status">
                      {loadError}
                    </p>
                  )}

                  {hasMore && (
                    <div className="mt-6 text-center">
                      <button
                        type="button"
                        onClick={loadMore}
                        disabled={isLoading}
                        className="inline-flex items-center gap-2 px-6 py-3 rounded-control border border-border text-body-sm font-medium text-ink-primary hover:border-brand-accent hover:bg-surface transition disabled:opacity-50"
                      >
                        {/* serverTotal, not the totalClinics prop: the prop is
                            the unfiltered count fixed at page load, so applying
                            a brand or service filter left this claiming more
                            remaining clinics than the filter can return. */}
                        {isLoading ? 'Loading...' : `Load more clinics (${Math.max(0, serverTotal - allClinics.length).toLocaleString()} remaining)`}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-2xl border border-border bg-surface p-8 text-center">
                  <p className="text-body text-ink-secondary">No clinics match your filters.</p>
                </div>
              )}
            </div>
          </div>

          {/* Browse by city: full grid. The city search box that used to sit
              under the hero rendered its options as <button>s, so until
              2026-09-07 this page had no crawlable link to any of its city
              pages. That box was replaced by the hero picker on 2026-09-10;
              this grid stays, matching BrandStatePage and ServiceStatePage. */}
          {allCities.length > 0 && (
            <div>
              <h2 className="font-serif text-h2 text-ink-primary mb-6">Cities in {state.name}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {allCities.map((c) => (
                  <Link
                    key={c.slug}
                    href={`/clinics/${state.slug}/${c.slug}`}
                    // Hundreds per state: no viewport prefetch (2026-09-24,
                    // docs/PAGE-SPEED-PLAN-2026-09-24.md). Still crawlable.
                    prefetch={false}
                    className="group flex items-center justify-between p-4 rounded-control border border-border bg-surface hover:border-brand-accent hover:bg-surface-warm transition-all"
                  >
                    <div>
                      <div className="font-medium text-body-sm text-ink-primary group-hover:text-brand-accent transition">{c.name}</div>
                      {/* clinicCount is an exact count(*), so the "+" was
                          simply false. See LISTING-FIX-PLAN TASK 4.5. */}
                      {c.clinicCount > 0 && (
                        <div className="text-caption text-ink-tertiary">
                          {c.clinicCount.toLocaleString()} clinic{c.clinicCount === 1 ? '' : 's'}
                        </div>
                      )}
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-tertiary group-hover:text-brand-accent flex-shrink-0">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* FAQs: preview only, the full set and its schema live on /faq/<category> */}
          <FaqBlock faqs={faqs} seeAll={data.faqSeeAll} />
        </div>
      </div>
    </>
  )
}
