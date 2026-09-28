import Link from 'next/link'
import { Header } from '@/components/header/Header'
import { Footer } from '@/components/footer/Footer'
import { BrandDirectoryListing } from '@/components/shared/BrandDirectoryListing'
import { LiveCountPill } from '@/components/shared/LiveCountPill'
import { LocationPicker } from '@/components/shared/LocationPicker'
import { FaqBlock } from '@/components/faq/FaqBlock'
import type { BrandStateData } from '@/lib/brand-queries'

type Props = { data: BrandStateData; schema: object[] }

export function BrandStatePage({ data, schema }: Props) {
  const { brand, state, cities, clinics, relatedServices, faqs, totalClinics } = data

  return (
    <>
      {schema.map((s, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(s).replace(/</g, '\\u003c') }} />
      ))}

      <Header />

      {/* Breadcrumb */}
      <div className="bg-surface border-b border-border">
        <div className="max-canvas py-3">
          <nav className="flex items-center gap-2 text-caption text-ink-tertiary flex-wrap" aria-label="Breadcrumb">
            <Link href="/" className="hover:text-ink-primary transition">Home</Link>
            <span>/</span>
            <Link href="/brands" className="hover:text-ink-primary transition">Brands</Link>
            <span>/</span>
            <Link href={`/brands/${brand.slug}`} className="hover:text-ink-primary transition">{brand.name}</Link>
            <span>/</span>
            <span className="text-ink-primary">{state.name}</span>
          </nav>
        </div>
      </div>

      {/* Hero */}
      {/* Matched to the pillar hero 2026-09-10: same cream band, same widths,
          no overline, tagline under the h1. The inline 8-city chip row that sat
          here came out in the same pass; it was an unlabelled subset of the full
          city grid a few hundred pixels below. The picker replaces it and lists
          every city, with its links always in the served HTML. */}
      <section className="bg-surface-warm border-b border-border pb-8 pt-8 md:pb-10 md:pt-10">
        <div className="max-canvas max-w-4xl">
          <h1 className="font-serif text-h1-m md:text-h1 font-medium leading-tight tracking-tight text-ink-primary mb-3">
            {brand.name} Injectors in {state.name}
          </h1>
          {brand.tagline && (
            <p className="font-serif text-lede-m md:text-lede text-ink-secondary">{brand.tagline}</p>
          )}
          {/* Sentence after the pill dropped 2026-08-07 (client request), and
              "verified" came out of the pill label with it. */}
          {totalClinics > 0 && (
            <div className="mt-5 flex flex-wrap gap-3">
              <LiveCountPill initial={totalClinics} label="clinics" singular="clinic" />
            </div>
          )}

          {cities.length > 0 && (
            <LocationPicker
              states={cities.map((c) => ({ code: c.slug, name: c.name, slug: c.slug, count: c.clinicCount }))}
              basePath={`/brands/${brand.slug}/${state.slug}`}
              label="Select a city"
            />
          )}
        </div>
      </section>

      <div className="section-pad bg-surface-canvas">
        <div className="max-canvas space-y-14">

          {/* Clinic listing with services filter */}
          <div>
            {/* The h2 that used to sit here was a fixed server count over a
                grid the listing filters, so it read "1,818 clinics" above 24
                filtered rows. The listing owns the heading now and feeds it the
                live total. See docs/LISTING-FIX-PLAN-2026-09-19.md TASK 4.4. */}
            <BrandDirectoryListing
              clinics={clinics}
              serviceOptions={relatedServices.map((s) => ({ id: s.id, name: s.name }))}
              emptyMessage={`No ${brand.name} clinics found in ${state.name} yet.`}
              emptyLink={{ href: `/brands/${brand.slug}`, label: `Browse all ${brand.name} clinics` }}
              brandSlug={brand.slug}
              stateSlug={state.slug}
              totalClinics={totalClinics}
              listingHeading={`{count} ${brand.name} clinic{s} in ${state.name}`}
            />
          </div>

          {/* City grid: every city, with per-city clinic counts */}
          {cities.length > 0 && (
            <div>
              <h2 className="font-serif text-h2 text-ink-primary mb-6">{brand.name} by city in {state.name}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {cities.map((c) => (
                  <Link
                    key={c.slug}
                    href={`/brands/${brand.slug}/${state.slug}/${c.slug}`}
                    // Hundreds per state: no viewport prefetch (2026-09-24).
                    prefetch={false}
                    className="group flex items-center justify-between p-4 rounded-xl border border-border bg-surface hover:border-brand-accent hover:bg-surface-warm transition-all"
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
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* FAQs: preview only, the full set and its schema live on /faq/<category> */}
          <FaqBlock faqs={faqs} seeAll={data.faqSeeAll} />

          {/* Internal links. The "All {brand} clinics" link came out 2026-09-10:
              the breadcrumb at the top already goes there. The clinics-tree link
              stays (founder call, same day); it is the only link on this page
              from the brand tree into /clinics. */}
          <div className="flex flex-wrap gap-3">
            <Link href={`/clinics/${state.slug}`} className="flex items-center gap-1.5 text-body-sm text-brand-accent hover:underline">
              All clinics in {state.name}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </Link>
          </div>
        </div>
      </div>

      <Footer />
    </>
  )
}
