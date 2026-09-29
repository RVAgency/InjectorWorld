import type { Metadata } from 'next'
import { Header } from '@/components/header/Header'
import { Footer } from '@/components/footer/Footer'
import {
  getSearchFilterOptions,
  readSearchPageRequest,
  searchPageResults,
  SEARCH_PAGE_SIZE,
  SEARCH_RESULT_CAP,
} from '@/lib/search-queries'
import { getLocationFilterOptions } from '@/lib/location-queries'
import { getTopResults } from '@/lib/search-content'
import { TopResults } from '@/components/search/TopResults'
import { HeaderSearchBar } from '@/components/header/HeaderSearchBar'
import { SearchMapSection } from '@/components/search/SearchMapSection'
import { SearchResultsWithFilters } from '@/components/search/SearchResultsWithFilters'
import { LiveCountPill } from '@/components/shared/LiveCountPill'
import { headers } from 'next/headers'
import { visitorZipCentre } from '@/lib/visitor-location'

// Results depend on query params and are not indexable, so render on demand.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Search verified injectors and clinics',
  description:
    'Search license-verified Botox and aesthetic injectors and clinics by treatment, location, ZIP, name, or anything in between.',
  robots: { index: false, follow: true },
}

/** A Next searchParams object as URLSearchParams. A repeated key keeps its first value. */
function toUrlSearchParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') usp.set(key, value)
    else if (Array.isArray(value) && typeof value[0] === 'string') usp.set(key, value[0])
  }
  return usp
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const usp = toUrlSearchParams(await searchParams)
  // Query, location and listing filters, read the same way /api/search/more
  // reads them for Load more (see readSearchPageRequest for what each means).
  const request = readSearchPageRequest(usp)
  const { q, treatment, location, barState, barCity, effectiveLocation, omniValue, hasQuery, filtersActive } =
    request

  // Page 1 is a generous window (SEARCH_PAGE_SIZE) that the results list
  // reveals 12 at a time; past it, Load more fetches the next page from
  // /api/search/more with this same query string. The listing filters are
  // applied in SQL, so the total is the real number of matches.
  // "near me" is answered from this visitor's ZIP. This page is dynamic and
  // never cached, so reading the request's location here is safe; it is only
  // looked up when a query actually says "near me".
  const requestHeaders = await headers()
  const [result, topResults, filterOptions, stateOptions] = hasQuery
    ? await Promise.all([
        searchPageResults(request, 1, () => visitorZipCentre(requestHeaders)),
        getTopResults(omniValue),
        getSearchFilterOptions(),
        getLocationFilterOptions(),
      ])
    : [
        {
          clinics: [],
          serviceLabel: undefined as string | undefined,
          locationLabel: undefined as string | undefined,
          clinicTotal: 0,
        },
        [],
        { brandOptions: [], serviceOptions: [] },
        [],
      ]

  const total = result.clinicTotal
  const zipNotice = 'zipNotice' in result ? result.zipNotice : undefined
  // Where the panel's Distance is measured from, and the radius the list is
  // already cut to (2026-09-29). See SearchResult.distanceOrigin.
  const distanceOrigin = 'distanceOrigin' in result ? (result.distanceOrigin ?? null) : null
  const appliedRadiusMiles = 'appliedRadiusMiles' in result ? (result.appliedRadiusMiles ?? null) : null
  const treatmentText = result.serviceLabel || treatment
  const brandText = result.brandLabel
  const locationText = result.locationLabel || effectiveLocation

  // Build a plain-language summary line (no em dashes).
  let summary = ''
  if (brandText && locationText) summary = `${brandText} injectors in ${locationText}`
  else if (brandText) summary = `${brandText} injectors`
  else if (treatmentText && locationText) summary = `${treatmentText} in ${locationText}`
  else if (treatmentText) summary = treatmentText
  else if (locationText) summary = `Injectors in ${locationText}`
  else if (q) summary = `Results for ${q}`

  return (
    <>
      <Header />

      {/* Search hero */}
      <section className="bg-surface border-b border-border pt-8 pb-8">
        <div className="max-canvas">
          <span className="text-overline uppercase tracking-widest font-semibold text-brand-accent mb-2 block">
            Search
          </span>
          <h1 className="font-serif text-h3 sm:text-h2-m md:text-h2 lg:text-h1 font-medium leading-tight tracking-tight text-ink-primary mb-1">
            {hasQuery ? (summary || 'Search results') : 'Find a verified injector'}
          </h1>
          {hasQuery ? (
            <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink-secondary mb-5">
              <LiveCountPill initial={total} label="results" singular="result" />
              <span>across verified clinics.</span>
            </p>
          ) : (
            <p className="text-body-sm text-ink-secondary mb-5">
              Search by treatment, location, ZIP, or name to find verified clinics.
            </p>
          )}
          <HeaderSearchBar defaultQuery={omniValue} className="max-w-2xl" autoFocus={!hasQuery} />
        </div>
      </section>

      {/* Results */}
      <section className="pt-6 md:pt-8 pb-20 md:pb-28 bg-surface-canvas">
        <div className="max-canvas">
          {!hasQuery ? (
            <p className="text-body text-ink-secondary py-8">
              Enter a treatment, location, ZIP, or name above to begin.
            </p>
          ) : (
            <>
              {/* With listing filters on, a zero still renders the results
                  block: the filter panel lives there, and hiding it would
                  leave the visitor no way to clear the filters that emptied
                  the list. */}
              {total === 0 && !filtersActive ? (
                topResults.length === 0 ? (
                  <div className="py-12 text-center">
                    <p className="text-body text-ink-primary font-medium mb-2">No matches found</p>
                    <p className="text-body-sm text-ink-secondary max-w-md mx-auto">
                      {/* Copy only (2026-09-25, QA T6-01): this used to name four
                          "launch markets" and call every other state coming soon,
                          while every state has been live since the September
                          directory swap. */}
                      Try a broader treatment, a nearby city, or a ZIP code. We list clinics in
                      every US state.
                    </p>
                  </div>
                ) : (
                  <p className="text-body-sm text-ink-secondary py-4">
                    No clinics matched, but the guides below may help.
                  </p>
                )
              ) : (
                <>
                  <p className="flex flex-wrap items-center gap-2 text-ink-secondary text-sm mb-4">
                    <LiveCountPill initial={total} label="results" singular="result" />
                    {/* Load more reaches SEARCH_RESULT_CAP; only past that is
                        refining the one way to see more. */}
                    {total > SEARCH_RESULT_CAP && <span>Refine your search for more.</span>}
                  </p>
                  {/* ZIP-centred search (2026-09-28): the ZIP's own clinics
                      lead. Same wording as the near-me listings' header. */}
                  {zipNotice && total > 0 && (
                    <p className="text-body-sm text-ink-secondary mb-4">
                      {zipNotice.zipCount === 0
                        ? `No clinics in ${zipNotice.zip}. Showing ${total.toLocaleString()} ${total === 1 ? 'clinic' : 'clinics'} within ${zipNotice.radiusMiles} ${zipNotice.radiusMiles === 1 ? 'mile' : 'miles'}.`
                        : `${zipNotice.zipCount.toLocaleString()} ${zipNotice.zipCount === 1 ? 'clinic' : 'clinics'} in ${zipNotice.zip}, plus nearby within ${zipNotice.radiusMiles} ${zipNotice.radiusMiles === 1 ? 'mile' : 'miles'} (${total.toLocaleString()} total)`}
                    </p>
                  )}
                  {locationText && result.clinics.length > 0 && (
                    <SearchMapSection clinics={result.clinics} />
                  )}
                  <SearchResultsWithFilters
                    clinics={result.clinics}
                    totalCount={total}
                    brandOptions={filterOptions.brandOptions}
                    serviceOptions={filterOptions.serviceOptions}
                    stateOptions={location ? [] : stateOptions}
                    initialState={barState}
                    initialCity={barCity}
                    searchQuery={usp.toString()}
                    pageSize={SEARCH_PAGE_SIZE}
                    resultCap={SEARCH_RESULT_CAP}
                    filtersActive={filtersActive}
                    distanceOrigin={distanceOrigin}
                    appliedRadiusMiles={appliedRadiusMiles}
                  />
                </>
              )}
              {/* Guides / brand hubs sit BELOW the clinic grid: on /search the
                  clinics are the answer, the editorial cards are the follow-up. */}
              <TopResults results={topResults} />
            </>
          )}
        </div>
      </section>

      {/* <PreFooterCta /> removed 2026-08-06 (client request), matching the
          homepage removal of 2026-07-31. The component itself is untouched. */}
      <Footer />
    </>
  )
}
