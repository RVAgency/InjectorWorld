import type { Metadata } from 'next'
import { Header } from '@/components/header/Header'
import { Footer } from '@/components/footer/Footer'
import { getClinicsListing, getClinicsStats } from '@/lib/clinic-queries'
import { getPayloadInstance } from '@/lib/payload-server'
import { getLocationFilterOptions } from '@/lib/location-queries'
import { LocationPicker } from '@/components/shared/LocationPicker'
import { staticPageMetadata } from '@/lib/seo-metadata'
import { ClinicsGrid } from './ClinicsGrid'
import { LiveClinicsStats } from '@/components/clinics/LiveClinicsStats'

export const revalidate = 300

export function generateMetadata(): Promise<Metadata> {
  return staticPageMetadata(
    '/clinics',
    'Aesthetic Clinics Directory | injector.world',
    'Browse verified aesthetic clinics across the US. Read patient reviews, check credentials, and find clinics near you.',
  )
}

export default async function ClinicsPage() {
  /**
   * No try/catch, deliberately (2026-09-22). This used to catch any failure,
   * empty every value and render anyway, and that render was cached for
   * `revalidate` seconds: no clinic links in the served HTML, no state picker,
   * and no Brand or Service filter (founder report, 2026-09-21). Throwing is the
   * fix: a failed runtime regeneration keeps serving the last good render and
   * retries on the next request, and a failed build keeps the previous deploy
   * live. See docs/LISTING-FIX-PLAN-2026-09-19.md TASK 6.
   */
  const payload = await getPayloadInstance()
  const [clinics, stats, stateOptions, servicesRes, brandsRes] = await Promise.all([
    getClinicsListing(24),
    getClinicsStats(),
    getLocationFilterOptions(),
    payload.find({ collection: 'services', limit: 100, sort: 'name', depth: 0 }),
    payload.find({ collection: 'brands', limit: 200, sort: 'name', depth: 0 }),
  ])
  const serviceOptions = (servicesRes.docs as any[]).map((s) => ({ id: String(s.id), name: s.name }))
  const brandOptions = (brandsRes.docs as any[]).map((b) => ({ id: String(b.id), name: b.name }))

  return (
    <>
      <Header />

      {/* Page hero — always-dark navy band (matches Footer pattern) */}
      <section className="bg-[#0B1B34] text-white pb-8 pt-8 md:pb-10 md:pt-10">
        <div className="max-canvas max-w-4xl">
          <p className="eyebrow text-brand-accent mb-4 tracking-widest">Clinics</p>
          <h1 className="font-serif text-h1-m md:text-h1 font-medium leading-tight tracking-tight mb-5 max-w-[680px]">
            Verified aesthetic clinics.
          </h1>
          <p className="text-lede-m md:text-lede text-white/70 max-w-[600px] font-serif">
            Every clinic listed here is independently reviewed. Browse by state, read patient reviews, and book with confidence.
          </p>

          {/* Quick stats. Real numbers only: a failed read now throws instead
              of rendering, so there is no placeholder case left to show.
              Served with the national figures; they follow the listing below
              once it reports (2026-09-28). */}
          <LiveClinicsStats initial={stats} />

          {/* State picker, matching the brand and service pillar heroes. It
              replaces the <select> that used to sit in the grid's filter bar,
              and every state link ships in the served HTML. */}
          {stateOptions.length > 0 && (
            <LocationPicker
              states={stateOptions.map((s) => ({ ...s, count: s.clinicCount }))}
              basePath="/clinics"
            />
          )}
        </div>
      </section>

      {/* Grid + filters */}
      <section className="section-pad bg-surface-canvas">
        <div className="max-canvas">
          <ClinicsGrid
            initialClinics={clinics}
            totalClinics={stats.total}
            serviceOptions={serviceOptions}
            brandOptions={brandOptions}
          />
        </div>
      </section>

      {/* <PreFooterCta /> removed 2026-08-06 (client request), matching the
          homepage removal of 2026-07-31. The component itself is untouched. */}
      <Footer />
    </>
  )
}
