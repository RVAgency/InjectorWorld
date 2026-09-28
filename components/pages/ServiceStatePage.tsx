import Link from 'next/link'
import { Header } from '@/components/header/Header'
import { Footer } from '@/components/footer/Footer'
import { ZipPromoBanner } from '@/components/shared/ZipPromoBanner'
import { ComingSoonMarket } from '@/components/shared/ComingSoonMarket'
import { ServiceDirectory } from '@/components/pages/ServiceDirectory'
import { LiveCountPill } from '@/components/shared/LiveCountPill'
import { LocationPicker } from '@/components/shared/LocationPicker'
import { FaqBlock } from '@/components/faq/FaqBlock'
import { isMarketLive } from '@/lib/markets'
import type { ServiceStateData } from '@/lib/location-queries'
import type { ActiveBanner } from '@/lib/promotions'

type Props = { data: ServiceStateData; banner: ActiveBanner | null; schema: object[] }

export function ServiceStatePage({ data, banner, schema }: Props) {
  const { service, state, cities, clinics, faqs, totalClinics, relatedBrands } = data

  // Coming-soon market: state not live yet. Page is noindexed in generateMetadata.
  if (!isMarketLive(state)) {
    return (
      <>
        <Header />
        <div className="bg-surface border-b border-border">
          <div className="max-canvas py-3">
            {/* Same trail as the live version below. These two blocks are
                near-duplicates and drift if either is edited alone. */}
            <nav className="flex items-center gap-2 text-caption text-ink-tertiary flex-wrap" aria-label="Breadcrumb">
              <Link href="/" className="hover:text-ink-primary transition">Home</Link>
              <span>/</span>
              <Link href="/services" className="hover:text-ink-primary transition">Services</Link>
              <span>/</span>
              <Link href={`/services/${service.slug}`} className="hover:text-ink-primary transition">{service.name}</Link>
              <span>/</span>
              <span className="text-ink-primary">{state.name}</span>
            </nav>
          </div>
        </div>
        <ComingSoonMarket
          overline={`${service.name} · Coming soon`}
          title={`${service.name} in ${state.name}`}
          placeName={state.name}
          stateCode={state.stateCode}
          links={[
            { href: `/services/${service.slug}`, label: `All ${service.name} providers` },
            { href: '/clinics', label: 'Browse all verified clinics' },
            { href: '/guides', label: 'Treatment guides' },
          ]}
        />
        <Footer />
      </>
    )
  }

  return (
    <>
      {schema.map((s, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(s).replace(/</g, '\\u003c') }} />
      ))}

      <Header />

      {/* Ad banner */}
      <ZipPromoBanner fallback={banner} serviceId={data.service?.id ? String(data.service.id) : undefined} />

      {/* Breadcrumb */}
      <div className="bg-surface border-b border-border">
        <div className="max-canvas py-3">
          {/* Home / Services / <service> / <state>, matching the brand state
              page and the JSON-LD BreadcrumbList this page renders. The
              "Services" crumb was missing until 2026-09-10, so there was no way
              up to the index from here. */}
          <nav className="flex items-center gap-2 text-caption text-ink-tertiary flex-wrap" aria-label="Breadcrumb">
            <Link href="/" className="hover:text-ink-primary transition">Home</Link>
            <span>/</span>
            <Link href="/services" className="hover:text-ink-primary transition">Services</Link>
            <span>/</span>
            <Link href={`/services/${service.slug}`} className="hover:text-ink-primary transition">{service.name}</Link>
            <span>/</span>
            <span className="text-ink-primary">{state.name}</span>
          </nav>
        </div>
      </div>

      {/* Hero */}
      {/* Matched to the pillar hero 2026-09-10: same cream band, same widths,
          no overline, tagline under the h1. The pill label lost the service
          name in the same pass; the h1 above already says it. The city picker
          lists every city and its links are always in the served HTML, so it
          adds a jump-to control without taking anything away from the city grid
          below.

          All six brand and service heroes carry `border-b border-border`
          (founder call, same day). The service pillar was the odd one out
          without it. */}
      <section className="bg-surface-warm border-b border-border pb-8 pt-8 md:pb-10 md:pt-10">
        <div className="max-canvas max-w-4xl">
          <h1 className="font-serif text-h1-m md:text-h1 font-medium leading-tight tracking-tight text-ink-primary mb-3">
            {service.name} Injectors in {state.name}
          </h1>
          {service.tagline && (
            <p className="font-serif text-lede-m md:text-lede text-ink-secondary">{service.tagline}</p>
          )}
          {/* Sentence after the pill dropped 2026-08-07 (client request), and
              "verified" came out of the pill label with it, matching the
              service city page. */}
          {totalClinics > 0 && (
            <div className="mt-5 flex flex-wrap gap-3">
              <LiveCountPill initial={totalClinics} label="clinics" singular="clinic" />
            </div>
          )}

          {cities.length > 0 && (
            <LocationPicker
              states={cities.map((c) => ({ code: c.slug, name: c.name, slug: c.slug, count: c.clinicCount }))}
              basePath={`/services/${service.slug}/${state.slug}`}
              label="Select a city"
            />
          )}
        </div>
      </section>

      <div className="section-pad bg-surface-canvas">
        <div className="max-canvas space-y-14">

          {/* Clinic listing with Brands-offered filter (locked rule: no Services filter here) */}
          <div>
            {/* The h2 that used to sit here was a fixed server count over a
                grid the listing filters, so it read "1,818 clinics" above 24
                filtered rows. The listing owns the heading now and feeds it the
                live total. See docs/LISTING-FIX-PLAN-2026-09-19.md TASK 4.4. */}
            <ServiceDirectory
              clinics={clinics}
              serviceName={service.name}
              serviceSlug={service.slug}
              stateSlug={state.slug}
              totalClinics={totalClinics}
              brandOptions={relatedBrands}
              listingHeading={`{count} ${service.name} clinic{s} in ${state.name}`}
            />
          </div>

          {/* Cities */}
          {cities.length > 0 && (
            <div>
              <h2 className="font-serif text-h2 text-ink-primary mb-6">{service.name} by city in {state.name}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {cities.map((c) => (
                  <Link
                    key={c.slug}
                    href={`/services/${service.slug}/${state.slug}/${c.slug}`}
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

          {/* Internal links. The "All {service} clinics" link came out
              2026-09-10: the breadcrumb at the top already goes there. The
              clinics-tree link stays (founder call, same day); it is the only
              link on this page from the service tree into /clinics. */}
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
