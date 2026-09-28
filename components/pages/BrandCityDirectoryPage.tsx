import Link from 'next/link'
import { Header } from '@/components/header/Header'
import { Footer } from '@/components/footer/Footer'
import { BrandDirectoryListing } from '@/components/shared/BrandDirectoryListing'
import { LiveCountPill } from '@/components/shared/LiveCountPill'
import { FaqBlock } from '@/components/faq/FaqBlock'
import type { BrandCityData } from '@/lib/brand-queries'

type Props = { data: BrandCityData; schema: object[] }

export function BrandCityDirectoryPage({ data, schema }: Props) {
  const { brand, city, stateLocation, clinics, relatedServices, faqs, totalClinics } = data
  const cityDisplay = city.name.replace(/\s+city$/i, '')

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
            {stateLocation && (
              <>
                <span>/</span>
                <Link href={`/brands/${brand.slug}/${stateLocation.slug}`} className="hover:text-ink-primary transition">{stateLocation.name}</Link>
              </>
            )}
            <span>/</span>
            <span className="text-ink-primary">{cityDisplay}</span>
          </nav>
        </div>
      </div>

      {/* Hero */}
      {/* Matched to the pillar hero 2026-09-10: same cream band, same widths, no
          overline, tagline under the h1. No picker here, this is the bottom of
          the brand tree and there is no next level to pick. */}
      <section className="bg-surface-warm border-b border-border pb-8 pt-8 md:pb-10 md:pt-10">
        <div className="max-canvas max-w-4xl">
          <h1 className="font-serif text-h1-m md:text-h1 font-medium leading-tight tracking-tight text-ink-primary mb-3">
            {brand.name} Injectors in {cityDisplay}, {city.stateCode}
          </h1>
          {brand.tagline && (
            <p className="font-serif text-lede-m md:text-lede text-ink-secondary">{brand.tagline}</p>
          )}
          {/* Dropped 2026-08-07 (client request): the sentence after the pill,
              the word "verified" in the pill, and the "Also browse:" service
              chips. The page is the pill, the listing and its filters. */}
          {totalClinics > 0 && (
            <div className="mt-5 flex flex-wrap gap-3">
              <LiveCountPill initial={totalClinics} label="clinics" singular="clinic" />
            </div>
          )}
        </div>
      </section>

      <div className="section-pad bg-surface-canvas">
        <div className="max-canvas space-y-12">

          {/* Clinic list with filters */}
          <div>
            {/* The h2 that used to sit here was a fixed server count over a
                grid the listing filters, so it read "368 clinics" above 24
                filtered rows. The listing owns the heading now and feeds it the
                live total. See docs/LISTING-FIX-PLAN-2026-09-19.md TASK 4.4. */}
            <BrandDirectoryListing
              clinics={clinics}
              serviceOptions={relatedServices.map((s) => ({ id: String(s.id), name: s.name }))}
              emptyMessage={`No clinics found for ${brand.name} in ${cityDisplay} yet.`}
              emptyLink={{ href: `/brands/${brand.slug}`, label: `Browse all ${brand.name} clinics` }}
              brandSlug={brand.slug}
              stateSlug={stateLocation?.slug}
              citySlug={city.slug}
              totalClinics={totalClinics}
              listingHeading={`{count} ${brand.name} clinic{s} in ${cityDisplay}`}
            />
          </div>

          {/* FAQs: preview only, the full set and its schema live on /faq/<category> */}
          <FaqBlock faqs={faqs} seeAll={data.faqSeeAll} />

          {/* The three internal links that sat above the footer (All X clinics
              / X in State / All clinics in City) were removed 2026-08-07
              (client request). The breadcrumb still covers those routes. */}
        </div>
      </div>

      <Footer />
    </>
  )
}
