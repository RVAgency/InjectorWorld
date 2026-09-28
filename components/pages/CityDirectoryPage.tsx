import Link from 'next/link'
import { Header } from '@/components/header/Header'
import { Footer } from '@/components/footer/Footer'
import { DirectoryClinicsView } from '@/components/shared/DirectoryClinicsView'
import { ZipPromoBanner } from '@/components/shared/ZipPromoBanner'
import { ComingSoonMarket } from '@/components/shared/ComingSoonMarket'
import { LiveCountPill } from '@/components/shared/LiveCountPill'
import { FaqBlock } from '@/components/faq/FaqBlock'
import { isMarketLive } from '@/lib/markets'
import type { CityDirectoryData } from '@/lib/location-queries'
import type { ActiveBanner } from '@/lib/promotions'

type Props = {
  data: CityDirectoryData
  banner: ActiveBanner | null
  schema: object[]
}

function EmptyDirectoryState({
  serviceName,
  serviceSlug,
  cityName,
  stateLocation,
  nearbyFallback,
}: {
  serviceName: string
  serviceSlug: string
  cityName: string
  stateLocation: { slug: string; name: string } | null
  nearbyFallback: { label: string; stateSlug: string; citySlug: string } | null
}) {
  const fallback = nearbyFallback ?? undefined
  return (
    <div className="rounded-2xl border border-border bg-surface p-8 text-center">
      <div className="w-14 h-14 rounded-full bg-brand-accent-soft flex items-center justify-center mx-auto mb-4">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--brand-accent))" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
        </svg>
      </div>
      <h2 className="font-serif text-h3 text-ink-primary mb-2">
        No verified clinics listed in {cityName} yet
      </h2>
      <p className="text-body-sm text-ink-secondary max-w-md mx-auto mb-6">
        We are actively adding clinics to this area. In the meantime, browse verified {serviceName.toLowerCase()} clinics in nearby cities.
      </p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        {stateLocation && (
          <Link
            href={`/services/${serviceSlug}/${stateLocation.slug}`}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-control bg-brand-primary text-surface-canvas text-body-sm font-semibold hover:opacity-90 transition"
          >
            Browse {stateLocation.name} clinics
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6" /></svg>
          </Link>
        )}
        {fallback && (
          <Link
            href={`/services/${serviceSlug}/${fallback.stateSlug}/${fallback.citySlug}`}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-control border border-border text-body-sm font-medium text-ink-primary hover:border-brand-accent hover:text-brand-accent transition"
          >
            {fallback.label} clinics
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6" /></svg>
          </Link>
        )}
        <Link
          href={`/services/${serviceSlug}`}
          className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-control border border-border text-body-sm font-medium text-ink-secondary hover:border-brand-accent hover:text-ink-primary transition"
        >
          All {serviceName} clinics
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6" /></svg>
        </Link>
      </div>
    </div>
  )
}

export function CityDirectoryPage({ data, banner, schema }: Props) {
  const { service, city, stateLocation, clinics, faqs, totalClinics } = data
  const stateCode = city.stateCode
  const cityDisplayName = city.name.replace(/\s+city$/i, '')

  // Coming-soon market: city not live yet. Render waitlist instead of the
  // directory. Page is noindexed in generateMetadata.
  if (!isMarketLive(city)) {
    return (
      <>
        <Header />
        <div className="bg-surface border-b border-border">
          <div className="max-canvas py-3">
            {/* Same trail as the live version below, which is the point: this
                block used to jump into the clinics tree while the live one did
                something else again. */}
            <nav className="flex items-center gap-2 text-caption text-ink-tertiary flex-wrap" aria-label="Breadcrumb">
              <Link href="/" className="hover:text-ink-primary transition">Home</Link>
              <span>/</span>
              <Link href="/services" className="hover:text-ink-primary transition">Services</Link>
              <span>/</span>
              <Link href={`/services/${service.slug}`} className="hover:text-ink-primary transition">{service.name}</Link>
              {stateLocation && (
                <>
                  <span>/</span>
                  <Link href={`/services/${service.slug}/${stateLocation.slug}`} className="hover:text-ink-primary transition">{stateLocation.name}</Link>
                </>
              )}
              <span>/</span>
              <span className="text-ink-primary">{city.name}</span>
            </nav>
          </div>
        </div>
        <ComingSoonMarket
          overline={`${service.name} · Coming soon`}
          title={`${service.name} in ${cityDisplayName}, ${stateCode}`}
          placeName={cityDisplayName}
          cityTag={cityDisplayName}
          stateCode={stateCode}
          links={[
            { href: `/services/${service.slug}`, label: `All ${service.name} providers` },
            ...(stateLocation ? [{ href: `/services/${service.slug}/${stateLocation.slug}`, label: `${service.name} in ${stateLocation.name}` }] : []),
            { href: '/clinics', label: 'Browse all verified clinics' },
          ]}
        />
        <Footer />
      </>
    )
  }

  /**
   * Home / Services / <service> / <state> / <city>, matching the brand city
   * page and the JSON-LD BreadcrumbList this page renders.
   *
   * Rebuilt 2026-09-10. It used to read Home / <state> / "<service> in <state>"
   * / <city>, which had three problems: the state crumb jumped into the clinics
   * tree and the next crumb jumped back into services, so it crossed trees
   * mid-trail; there was no Services or <service> crumb, so the pillar was
   * unreachable from here; and it disagreed with this page's own JSON-LD, which
   * described a different trail entirely.
   *
   * The `/clinics/<state>` link this used to carry is gone with it. That is
   * deliberate and matches the brand city page, which has never had one. The
   * clinics tree is still linked from the service STATE page, one level up.
   */
  const breadcrumbItems = [
    { href: '/', label: 'Home' },
    { href: '/services', label: 'Services' },
    { href: `/services/${service.slug}`, label: service.name },
    ...(stateLocation ? [{ href: `/services/${service.slug}/${stateLocation.slug}`, label: stateLocation.name }] : []),
    { label: city.name },
  ]

  return (
    <>
      {schema.map((s, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(s).replace(/</g, '\\u003c') }} />
      ))}

      <Header />

      <ZipPromoBanner fallback={banner} serviceId={data.service?.id ? String(data.service.id) : undefined} />

      {/* Breadcrumb */}
      <div className="bg-surface border-b border-border">
        <div className="max-canvas py-3">
          <nav className="flex items-center gap-2 text-caption text-ink-tertiary flex-wrap" aria-label="Breadcrumb">
            {breadcrumbItems.map((item, i) => (
              <span key={i} className="flex items-center gap-2">
                {i > 0 && <span>/</span>}
                {item.href ? (
                  <Link href={item.href} className="hover:text-ink-primary transition">{item.label}</Link>
                ) : (
                  <span className="text-ink-primary">{item.label}</span>
                )}
              </span>
            ))}
          </nav>
        </div>
      </div>

      {/* Hero */}
      {/* Matched to the pillar hero 2026-09-10: same cream band, same widths,
          no overline, tagline under the h1, and the pill label lost the service
          name because the h1 above already says it. No picker here, this is the
          bottom of the service tree and there is no next level to pick.

          All six brand and service heroes carry `border-b border-border`
          (founder call, same day). */}
      <section className="bg-surface-warm border-b border-border pb-8 pt-8 md:pb-10 md:pt-10">
        <div className="max-canvas max-w-4xl">
          <h1 className="font-serif text-h1-m md:text-h1 font-medium leading-tight tracking-tight text-ink-primary mb-3">
            {/* "Injectors", not "Clinics" (founder call, 2026-09-10). Both city
                pages briefly read "Clinics" earlier the same day; "Injectors"
                is what the pillar and the state pages say, so all four levels
                of both paths now use the one word. */}
            {service.name} Injectors in {cityDisplayName}, {stateCode}
          </h1>
          {service.tagline && (
            <p className="font-serif text-lede-m md:text-lede text-ink-secondary">{service.tagline}</p>
          )}
          {/* Dropped 2026-08-07 (client request): the sentence after the pill,
              the word "verified" in the pill, and the two check-mark trust
              lines under it. */}
          {totalClinics > 0 && (
            <div className="mt-5 flex flex-wrap gap-3">
              <LiveCountPill initial={totalClinics} label="clinics" singular="clinic" />
            </div>
          )}
        </div>
      </section>

      <div className="section-pad bg-surface-canvas">
        <div className="max-canvas">
          {/* Single column as of 2026-08-07 (client request). The right rail
              (Explore more links, the guide card and the trust box) is gone, so
              the page is the listing: DirectoryClinicsView already puts its
              filters on the left and the clinics on the right. */}
          <div>
              {clinics.length === 0 ? (
                <EmptyDirectoryState
                  serviceName={service.name}
                  serviceSlug={service.slug}
                  cityName={cityDisplayName}
                  stateLocation={stateLocation ?? null}
                  nearbyFallback={data.nearbyFallback}
                />
              ) : (
                <DirectoryClinicsView
                  clinics={clinics}
                  totalClinics={totalClinics}
                  loadMoreUrl={
                    stateLocation
                      ? `/api/service-city-clinics?serviceSlug=${encodeURIComponent(service.slug)}&stateSlug=${encodeURIComponent(stateLocation.slug)}&citySlug=${encodeURIComponent(city.slug)}`
                      : undefined
                  }
                  brandOptions={data.relatedBrands.map((b) => ({ id: b.id, name: b.name }))}
                />
              )}

              {/* FAQs: preview only, the full set and its schema live on /faq/<category> */}
              <FaqBlock faqs={faqs} seeAll={data.faqSeeAll} className="mt-12" headingClassName="font-serif text-h3 text-ink-primary mb-5" listClassName="space-y-2" />

            {/* The right rail lived here until 2026-08-07 (client request):
                "Explore more" links, the treatment-guide card and the trust
                box. */}
          </div>
        </div>
      </div>

      <Footer />
    </>
  )
}
