import Link from 'next/link'
import { Header } from '@/components/header/Header'
import { Footer } from '@/components/footer/Footer'
import { BrandDirectoryListing } from '@/components/shared/BrandDirectoryListing'
import { LocationPicker } from '@/components/shared/LocationPicker'
import { LiveCountPill } from '@/components/shared/LiveCountPill'
import { FaqBlock } from '@/components/faq/FaqBlock'
import type { BrandPillarData } from '@/lib/brand-queries'

type Props = { data: BrandPillarData; schema: object[] }

export function BrandPillarPage({ data, schema }: Props) {
  const { brand, topClinics, states, relatedServices, faqs, totalClinics } = data

  return (
    <>
      {schema.map((s, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(s).replace(/</g, '\\u003c') }} />
      ))}

      <Header />

      {/* Breadcrumb */}
      <div className="bg-surface border-b border-border">
        <div className="max-canvas py-3">
          <nav className="flex items-center gap-2 text-caption text-ink-tertiary" aria-label="Breadcrumb">
            <Link href="/" className="hover:text-ink-primary transition">Home</Link>
            <span>/</span>
            <Link href="/brands" className="hover:text-ink-primary transition">Brands</Link>
            <span>/</span>
            <span className="text-ink-primary">{brand.name}</span>
          </nav>
        </div>
      </div>

      {/* Hero */}
      {/* Trimmed 2026-08-07 (client request): the hero keeps the headline, the
          tagline, the clinic count and the state picker. The short description,
          the manufacturer / longevity / downtime chips and the average cost line
          all came out, and the padding came down with them. The city dropdown
          that sat beside the state one was removed 2026-09-08. */}
      <section className="bg-surface-warm border-b border-border pb-8 pt-8 md:pb-10 md:pt-10">
        <div className="max-canvas max-w-4xl">
          <h1 className="font-serif text-h1-m md:text-h1 font-medium leading-tight tracking-tight text-ink-primary mb-3">
            {brand.name} Injectors Near You
          </h1>
          {brand.tagline && (
            <p className="font-serif text-lede-m md:text-lede text-ink-secondary">{brand.tagline}</p>
          )}

          {totalClinics > 0 && (
            <div className="mt-5 flex flex-wrap gap-3">
              <LiveCountPill initial={totalClinics} label="clinics" singular="clinic" nearMe />
            </div>
          )}

          <LocationPicker
            states={states.map((s) => ({ ...s, count: s.clinicCount }))}
            basePath={`/brands/${brand.slug}`}
          />
        </div>
      </section>

      <div className="section-pad bg-surface-canvas">
        <div className="max-canvas space-y-16">

          {/* The full-width state grid and the "Popular:" city row lived here
              until 2026-08-07 (client request), replaced by the hero picker.
              That swap silently broke the crawl path: the picker's links were
              real <Link>s but were only mounted while the menu was open, so they
              never reached the served HTML. Fixed 2026-09-07 by keeping the menu
              in the DOM and hiding it with CSS. Cities are reached from the
              state page, which lists them as plain anchors. */}

          {/* Top clinics listing with services filter */}
          <div>
            {/* The listing heading moved INTO BrandDirectoryListing on
                2026-09-10 so the ZIP-located version ("Top Clinics in 77009,
                Houston, TX") can replace it after hydration. It is still
                server-rendered from there, so the served HTML is unchanged. */}
            <BrandDirectoryListing
              clinics={topClinics}
              serviceOptions={relatedServices.map((s) => ({ id: s.id, name: s.name }))}
              emptyMessage={`No ${brand.name} clinics found yet.`}
              brandSlug={brand.slug}
              totalClinics={totalClinics}
              listingHeading={`Find a ${brand.name} provider near you`}
            />
          </div>

          {/* FAQs: preview only, the full set and its schema live on /faq/<category> */}
          <FaqBlock faqs={faqs} seeAll={data.faqSeeAll} />

          {/* Guide CTA */}
          {brand.guide && (
            <div className="rounded-2xl border border-border bg-surface-warm p-8 text-center">
              <h2 className="font-serif text-h2 text-ink-primary mb-3">{brand.guide.title}</h2>
              <p className="text-body text-ink-secondary mb-6 max-w-xl mx-auto">{brand.guide.lede}</p>
              <Link
                href={`/guides/${brand.guide.slug}`}
                className="inline-flex items-center gap-2 bg-brand-primary text-surface-canvas rounded-control px-6 py-3 text-body-sm font-semibold hover:opacity-90 transition"
              >
                Read the complete guide
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
              </Link>
            </div>
          )}

          {/* Website link */}
          {brand.websiteUrl && (
            <p className="text-body-sm text-ink-tertiary">
              Learn more at{' '}
              <a href={brand.websiteUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-accent hover:underline">
                {brand.name} official site
              </a>
            </p>
          )}
        </div>
      </div>

      <Footer />
    </>
  )
}
