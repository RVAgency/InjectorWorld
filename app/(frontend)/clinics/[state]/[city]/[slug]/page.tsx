import type { Metadata } from 'next'
import type { ComponentType, ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Header } from '@/components/header/Header'
import { Footer } from '@/components/footer/Footer'
import { ClinicPathBreadcrumb } from '@/components/clinics/ClinicPathBreadcrumb'
import { ClinicSaveButton } from '@/components/clinics/ClinicSaveButton'
import { ShareButton } from '@/components/clinics/ShareButton'
import { ACTION_CIRCLE, ACTION_LABEL, ACTION_STACK } from '@/components/clinics/hero-actions'
import { OwnerCompletionBanner } from '@/components/clinics/OwnerCompletionBanner'
import { computeClinicCompleteness } from '@/lib/clinic-completeness'
import { ClinicMapLazy } from '@/components/clinics/ClinicMapLazy'
import { DirectoryClinicCard } from '@/components/shared/DirectoryClinicCard'
import { WIDE_CARD_SIZES } from '@/lib/card-sizes'
import { PracticeNotes } from '@/components/clinics/PracticeNotes'
import { TrackEvent } from '@/components/analytics/TrackEvent'
import { FaqAccordionItem } from '@/components/shared/FaqAccordionItem'
import {
  getAllClinicParams,
  getClinicBySlug,
  type ClinicDetail,
  type ClinicFaq,
  type ClinicHours,
} from '@/lib/clinic-queries'
import { getEntityRobots } from '@/lib/page-index/queries'
import { buildPageMetadata, withTitleSuffix } from '@/lib/seo-metadata'
import { webPageRef } from '@/lib/json-ld'
import { formatPhoneDisplay, toTelHref } from '@/lib/format-phone'
import { ClinicHoursBar } from '@/components/clinics/ClinicHoursBar'
import { ClinicCoverPhoto } from '@/components/clinics/ClinicCoverPhoto'
import { BookPill } from '@/components/clinics/BookPill'
import { ConsultationForm } from '@/components/booking/ConsultationForm'

export const revalidate = 300

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://injector.world'
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const DAY_LABELS: Record<(typeof DAY_KEYS)[number], string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
}

export async function generateStaticParams() {
  try {
    return await getAllClinicParams()
  } catch {
    return []
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ state: string; city: string; slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const clinic = await getClinicBySlug(slug)
  if (!clinic) return {}

  // Overview text wins when the clinic has one (founder call, 2026-09-18).
  // Without it, the client's fallback sentence is used, and the review clause is
  // dropped when there are no reviews: 39,007 of 57,601 clinics have none, and
  // "with 0 patient reviews" reads as a warning. See
  // docs/SEO-TITLES-DESCRIPTIONS-2026-09-18.md.
  const reviewCount = clinic.aggregateRatingCount ?? 0
  const description = clinic.description
    ? truncate(clinic.description, 155)
    : `${clinic.clinicName} is a ${formatClinicType(clinic.clinicType)} in ${clinic.city}, ${clinic.state}${
        reviewCount > 0 ? ` with ${reviewCount.toLocaleString('en-US')} patient reviews` : ''
      }. See credentials, treatments offered, and amenities before you book your appointment.`

  return buildPageMetadata({
    title: withTitleSuffix(`${clinic.clinicName} - ${clinic.city}, ${clinic.state}`),
    description,
    url: `${SITE_URL}/clinics/${clinic.stateSlug}/${clinic.citySlug}/${clinic.slug}`,
    image: clinic.photoUrls[0] ? { url: clinic.photoUrls[0] } : null,
    imageAlt: `${clinic.clinicName} in ${clinic.city}, ${clinic.state}`,
    // Indexability comes from the url registry, keyed on the clinic doc rather
    // than the path (slugs can drift; the id cannot). A clinic page is indexed
    // only once it has been batched in from the admin Indexing screen -- until
    // then it stays crawlable but noindex. The registry's own `publishable` gate
    // still covers the correctness case this used to handle inline: an
    // unpublished clinic can never resolve indexed.
    robots: await getEntityRobots('clinics', clinic.id),
  })
}

export default async function ClinicDetailPage({
  params,
}: {
  params: Promise<{ state: string; city: string; slug: string }>
}) {
  const { slug } = await params
  const clinic = await getClinicBySlug(slug)
  if (!clinic) notFound()

  /**
   * KNOWN, DELIBERATELY NOT FIXED HERE (2026-09-07).
   *
   * The lookup is by slug alone, so every state/city pair in the country serves
   * the same clinic with a 200: an Austin clinic answers at
   * /clinics/ohio/cleveland-oh/<slug>. The canonical below always points at the
   * real url, so nothing is mis-indexed, and no link on the site produces a
   * wrong prefix. It is a latent url-space issue, not an active one.
   *
   * A `permanentRedirect` here was tried and reverted the same day. This route
   * has generateStaticParams + revalidate, so it is prerender-capable, and
   * redirecting from it made Next emit the Location header TWICE, comma-joined:
   *   location: /clinics/texas/austin-tx/x,/clinics/texas/austin-tx/x
   * which is invalid per RFC 9110. It happened on a cache MISS too, so it was
   * not a stale-cache artifact. The sibling redirects at
   * /clinics/[state] and /clinics/[state]/[city] are fine precisely because
   * they have no generateStaticParams and stay dynamic.
   *
   * If this is picked up later, the two candidates are notFound() on a
   * mismatched prefix (clean under ISR, but turns any stale external link with
   * an old city segment into a dead end), or a redirect from somewhere that is
   * not prerender-capable. Either needs testing on a deployed environment,
   * because the duplicate header does not show up locally in tsc.
   */

  const canonicalUrl = `${SITE_URL}/clinics/${clinic.stateSlug}/${clinic.citySlug}/${clinic.slug}`
  // Clinic-specific questions built from this clinic's own data. The FAQ
  // collection is not read here (docs/FAQ-SYSTEM-2026-09-13.md).
  const faqs = buildFallbackFaqs(clinic)
  const schema = buildSchema(clinic, canonicalUrl, faqs)
  const hasCoords = hasValidCoordinates(clinic.latitude, clinic.longitude)
  const address = fullAddress(clinic)
  // Same link the map's own button uses. The hero used to point at
  // googleMapsUrl, which is a place_id lookup and only shows the pin: the two
  // "Get directions" on one page did different things (fixed 2026-08-10).
  const directionsHref = clinic.directionsUrl || clinic.googleMapsUrl
  const updatedLabel = clinic.updatedAt
    ? new Date(clinic.updatedAt).toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : null
  const missingProfileLabels = computeClinicCompleteness({
    photos: clinic.photoUrls,
    servicesOffered: clinic.servicesOffered,
    phone: clinic.phone,
    email: clinic.email,
    websiteUrl: clinic.websiteUrl,
    description: clinic.description,
    hoursJson: clinic.hoursJson,
  })
    .filter((step) => !step.done)
    .map((step) => step.label)

  return (
    <>
      {schema.map((item, index) => (
        <script
          key={index}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJson(item) }}
        />
      ))}

      <Header />
      <TrackEvent type="clinic_view" entityType="clinic" entityId={Number(clinic.id)} />

      <ClinicPathBreadcrumb
        stateSlug={clinic.stateSlug}
        stateName={titleFromSlug(clinic.stateSlug)}
        citySlug={clinic.citySlug}
        cityName={clinic.city}
        clinicName={clinic.clinicName}
      />

      <main className="bg-surface-canvas">
        <section className="border-b border-border bg-surface-canvas py-8 md:py-12">
          <div className="max-canvas">
            {/* 50/50 as of 2026-08-06 (client request): the cover ends on the
                vertical midline of the page rather than running wider.

                Centred, not top-aligned (2026-08-11). Clinic names run one line
                or two, so a top-aligned column started every page at a different
                height against the photo. Reserving two lines in the h1 fixed the
                alignment but left visible dead air under short names, which the
                client rejected. Centring absorbs the extra line symmetrically
                instead: a two-line name grows a little in both directions rather
                than pushing the whole column down. */}
            {/* `[&>*]:min-w-0` (2026-09-25, QA T4-01): a grid item defaults to
                min-width:auto, so below lg the photo gallery's md:flex thumbnail
                strip stretched this one column to ~912px and the whole page
                scrolled sideways between 768 and 1023. */}
            <div className="grid gap-8 lg:grid-cols-2 lg:items-center [&>*]:min-w-0">
              <ClinicCoverPhoto clinicName={clinic.clinicName} photoUrls={clinic.photoUrls} />

              {/* Rebuilt 2026-08-10 (client request) as a Google business panel:
                  the name leads, rating and last-updated share a line, and every
                  contact detail is an icon + text row on one grid. The clinic
                  type chip that used to sit above the name is gone from the front
                  end (the field itself stays, and still feeds the meta
                  description). */}
              <div className="space-y-5">
                <div>
                  <h1 className="font-serif text-h1-m leading-tight text-ink-primary md:text-h1">
                    {clinic.clinicName}
                  </h1>

                  {(clinic.aggregateRating || updatedLabel) && (
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                      {/* Ternary, not &&: rating and the date now share a row, so
                          a 0 rating would print a bare "0" next to "Updated:". */}
                      {clinic.aggregateRating ? (
                        <span className="group flex items-center gap-2">
                          {/* Star stays gold on hover; the chip carries the
                              accent. Turning the star mint would fight the
                              state/star token, which exists for exactly this. */}
                          <span
                            className={`${RATING_CHIP} text-state-star group-hover:border-brand-accent group-hover:bg-brand-accent-soft`}
                            aria-hidden
                          >
                            <StarIcon />
                          </span>
                          <span className="font-semibold text-body-sm text-ink-primary">
                            {clinic.aggregateRating.toFixed(1)}
                          </span>
                          {/* Hidden at 0. A rating with "(0 reviews)" beside it
                              reads as broken data rather than as a new clinic. */}
                          {(clinic.aggregateRatingCount ?? 0) > 0 && (
                            <span className="text-body-sm text-ink-secondary">
                              ({clinic.aggregateRatingCount!.toLocaleString()} reviews)
                            </span>
                          )}
                        </span>
                      ) : null}
                      {/* History icon, not a clock: the clock belongs to the Hours
                          row further down and two of them in one panel would read
                          as the same thing. MM/DD/YYYY on purpose, US market. */}
                      {updatedLabel && (
                        <span className="group flex items-center gap-2">
                          <span
                            className={`${RATING_CHIP} text-ink-tertiary group-hover:border-brand-accent group-hover:bg-brand-accent-soft group-hover:text-brand-accent`}
                            aria-hidden
                          >
                            <HistoryIcon />
                          </span>
                          <span className="text-caption text-ink-tertiary">Updated: {updatedLabel}</span>
                        </span>
                      )}
                    </div>
                  )}

                  {/* Contact moved into the hero 2026-08-06 (client request), and
                      un-gated with it: phone, website and social are public for
                      everyone. Email is the sole exception and only appears once a
                      claimed clinic opts in via emailPublic. The old quick-info bar
                      and the sidebar "Clinic details" card both held this and are
                      gone. */}
                  <div className="mt-5 space-y-3">
                    {/* The address is the directions link itself (client request
                        2026-08-11). It replaced a separate "Get directions": first
                        a labelled link on its own row, then an inline icon chip
                        with a tooltip. Both were an extra thing to explain for a
                        destination the address already names. Styled exactly like
                        the phone and website values so the column has one idea of
                        what a link looks like. */}
                    <DetailRow icon={PinIcon} label="Address">
                      {directionsHref ? (
                        <a
                          href={directionsHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-body font-medium text-brand-accent hover:underline"
                        >
                          {address}
                        </a>
                      ) : (
                        <p className="text-body text-ink-secondary">{address}</p>
                      )}
                    </DetailRow>

                    {clinic.phone && (
                      <DetailRow icon={PhoneIcon} label="Call">
                        <a
                          href={`tel:${toTelHref(clinic.phone)}`}
                          className="text-body font-medium text-brand-accent hover:underline"
                        >
                          {formatPhoneDisplay(clinic.phone)}
                        </a>
                      </DetailRow>
                    )}

                    {clinic.websiteUrl && (
                      <DetailRow icon={GlobeIcon} label="Website">
                        <a
                          href={clinic.websiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="break-words text-body font-medium text-brand-accent hover:underline"
                        >
                          {displayUrl(clinic.websiteUrl)}
                        </a>
                      </DetailRow>
                    )}

                    {clinic.email && clinic.claimed && clinic.emailPublic && (
                      <DetailRow icon={MailIcon} label="Email">
                        <a
                          href={`mailto:${clinic.email}`}
                          className="break-words text-body font-medium text-brand-accent hover:underline"
                        >
                          {clinic.email}
                        </a>
                      </DetailRow>
                    )}

                    {/* Hours goes last: its dropdown is seven rows tall, and from
                        any earlier slot opening it would shove phone and website
                        down the page. Moved here from the full-width strip that
                        used to sit under the hero (client request 2026-08-11). */}
                    {clinic.hoursJson && (
                      <DetailRow icon={ClockIcon} label="Hours">
                        <ClinicHoursBar hours={clinic.hoursJson} />
                      </DetailRow>
                    )}
                  </div>

                  {/* One row: social links, then Save and Share. The "SOCIAL"
                      eyebrow and the two bordered Save/Share pills below it were
                      dropped 2026-08-10. Every item carries a label as of
                      2026-08-11, social included. */}
                  <div className="mt-6 flex flex-wrap items-start gap-1.5 sm:gap-2.5">
                    {socialChannels(clinic).map((channel) => (
                      <a
                        key={channel.label}
                        href={channel.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={channel.label}
                        className={`${ACTION_STACK} group`}
                      >
                        <span className={ACTION_CIRCLE}>{channel.icon}</span>
                        <span className={ACTION_LABEL}>{channel.label}</span>
                      </a>
                    ))}
                    <ClinicSaveButton clinicId={clinic.id} />
                    <ShareButton clinicId={Number(clinic.id)} clinicName={clinic.clinicName} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* The full-width hours strip that sat here moved into the hero's
            details list on 2026-08-11 (client request). */}

        {/* Bottom padding trimmed 2026-08-06: this section and "Other clinics"
            below both carried section-pad on the same background, so ~190px of
            empty canvas sat between the last FAQ and the next heading. */}
        <section className="pb-12 pt-20 md:pb-16 md:pt-28">
          <div className="max-canvas">
            {/* Left column sections are separated by a hairline, matching the
                prototype. Deliberately no eyebrow labels above the headings
                ("Gallery", "Menu", "Good to know" and friends): client dropped
                them 2026-08-06. */}
            <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-14">
              <div className="[&>section]:border-b [&>section]:border-border-subtle [&>section]:pb-12 [&>section]:mb-12 [&>section:last-child]:border-b-0 [&>section:last-child]:pb-0 [&>section:last-child]:mb-0">
                {clinic.description && (
                  <section>
                    <h2 className="mb-4 font-serif text-h3 text-ink-primary">Overview</h2>
                    <p className="text-body leading-relaxed text-ink-secondary">{clinic.description}</p>
                    {/* The Established / visit-type / county pills that sat here
                        were dropped 2026-08-10 (client request). All three fields
                        are still on the clinic, just not surfaced. */}
                  </section>
                )}

                {(clinic.servicesOffered.length > 0 || clinic.brandsOffered.length > 0) && (
                  <section>
                    <h2 className="mb-5 font-serif text-h3 text-ink-primary">
                      Treatments / Services Offered
                    </h2>
                    {clinic.servicesOffered.length > 0 && (
                      <div className="mb-5">
                        <p className="mb-3 text-caption font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Services</p>
                        <div className="flex flex-wrap gap-2">
                          {clinic.servicesOffered.map((treatment) => (
                            <Link
                              key={treatment.id}
                              href={`/services/${treatment.slug}/${clinic.stateSlug}/${clinic.citySlug}`}
                              className="rounded-control border border-border px-4 py-2 text-body-sm font-medium text-ink-primary transition hover:border-brand-accent hover:text-brand-accent"
                            >
                              {treatment.name}
                            </Link>
                          ))}
                        </div>
                      </div>
                    )}
                    {clinic.brandsOffered.length > 0 && (
                      <div>
                        <p className="mb-3 text-caption font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Brands</p>
                        <div className="flex flex-wrap gap-2">
                          {clinic.brandsOffered.map((brand) => (
                            <Link
                              key={brand.id}
                              href={`/brands/${brand.slug}`}
                              className="rounded-control border border-border px-4 py-2 text-body-sm font-medium text-ink-primary transition hover:border-brand-accent hover:text-brand-accent"
                            >
                              {brand.name}
                            </Link>
                          ))}
                        </div>
                      </div>
                    )}
                  </section>
                )}

                {hasCoords && (
                  <section>
                    <h2 className="mb-5 font-serif text-h3 text-ink-primary">Map</h2>
                    <ClinicMapLazy
                      clinicName={clinic.clinicName}
                      latitude={clinic.latitude}
                      longitude={clinic.longitude}
                      directionsUrl={clinic.directionsUrl || clinic.googleMapsUrl}
                    />
                  </section>
                )}

                {/* The "Book a consult" card that sat here is gone: the sidebar
                    now carries the real form, so this was a duplicate CTA. */}

                {/* The Photos section (grid + lightbox) was removed 2026-08-10 at
                    the client's request, and components/clinics/ClinicPhotoGallery
                    was deleted with it. Photos live in the hero gallery now,
                    capped at 8. */}

                {/* Owner card sits between Photos and Practice notes, as in the
                    prototype (moved out of the full-width band 2026-08-06). Only
                    one of these two ever shows: the claim card is for everyone
                    while a clinic is unclaimed, and OwnerCompletionBanner
                    renders null unless the signed-in owner is looking. */}
                {!clinic.claimed && (
                  <section>
                    <div className="rounded-2xl bg-brand-accent-soft p-7 md:p-9">
                      <h2 className="font-serif text-h3 text-ink-primary">Is this your clinic?</h2>
                      <p className="mt-2 max-w-[60ch] text-body-sm text-ink-secondary">
                        Claim this free profile to update your info, add photos and your full service
                        menu, and respond to patient inquiries.
                      </p>
                      <div className="mt-5 flex flex-wrap items-center gap-4">
                        <Link
                          href={`/claim/clinic/${clinic.slug}`}
                          className="inline-flex min-h-11 items-center justify-center rounded-control bg-brand-primary px-6 py-3 text-body-sm font-semibold text-surface-canvas transition hover:opacity-90"
                        >
                          Claim this profile
                        </Link>
                        <span className="text-body-sm text-ink-secondary">Free · Takes about a minute</span>
                      </div>
                    </div>
                  </section>
                )}

                {clinic.claimed && (
                  <OwnerCompletionBanner clinicId={clinic.id} missingLabels={missingProfileLabels} />
                )}

                {(clinic.amenities || clinic.paymentMethods || clinic.acceptsInsurance) && (
                  <section>
                    <h2 className="mb-5 font-serif text-h3 text-ink-primary">Practice notes</h2>
                    <PracticeNotes
                      amenities={clinic.amenities}
                      paymentMethods={clinic.paymentMethods}
                      acceptsInsurance={clinic.acceptsInsurance}
                    />
                  </section>
                )}

                {clinic.reviews.length > 0 && <ReviewsSection clinic={clinic} />}

                {faqs.length > 0 && (
                  <section>
                    <h2 className="mb-5 font-serif text-h3 text-ink-primary">FAQs</h2>
                    <div className="space-y-3">
                      {faqs.map((faq) => (
                        <FaqAccordionItem
                          key={faq.id}
                          question={faq.question}
                          answer={faq.answer}
                          detail={faq.detail}
                          offLabel={faq.offLabel}
                          safetyFlag={faq.safetyFlag}
                          relatedGuideSlug={faq.relatedGuideSlug}
                          relatedGuideTitle={faq.relatedGuideTitle}
                        />
                      ))}
                    </div>
                  </section>
                )}

                <section>
                  <a
                    href={`mailto:support@injector.world?subject=${encodeURIComponent(`Issue with ${clinic.clinicName} listing`)}`}
                    className="text-caption text-ink-tertiary underline transition hover:text-ink-primary"
                  >
                    Report an issue with this listing
                  </a>
                </section>
              </div>

              {/* Sidebar is the booking form (client request 2026-08-06).
                  Everything else that used to live here moved into the left
                  column or the hero: gallery, hours, practice notes, contact
                  details. The "Top-rated in {city} · N reviews" chip that used
                  to open this card is gone (2026-08-11): the rating already
                  shows in the hero, and it duplicated that.

                  A media block (YouTube embed, photo-carousel fallback) briefly
                  sat above this card on 2026-08-11 and was removed the same day
                  (client request — channels stay in the hero's social row only,
                  for now). ClinicSidebarMedia and lib/youtube.ts were deleted
                  with it; see docs/DECISIONS.md if this needs rebuilding. */}
              <aside className="lg:sticky lg:top-24 lg:self-start">
                <div id="book" className="scroll-mt-24 rounded-2xl border border-border bg-surface-canvas p-5 shadow-md">
                  <h2 className="font-serif text-h3 text-ink-primary">Book a consultation</h2>
                  <p className="mt-1.5 text-body-sm text-ink-secondary">
                    Your request goes to the clinic. We do not store payment details. Free to inquire.
                  </p>
                  <ConsultationForm
                    kind="clinic"
                    targetId={Number(clinic.id)}
                    targetName={clinic.clinicName}
                    servicesOffered={clinic.servicesOffered}
                    active
                    className="mt-4 space-y-3.5"
                  />
                  <p className="mt-3 text-center text-caption text-ink-tertiary">
                    Clinics typically reply within 1 to 2 business days.
                  </p>
                </div>
              </aside>
            </div>
          </div>
        </section>

        {/* Both owner cards moved into the left column 2026-08-06. */}

        {/* Own background + top rule, like the prototype, so the change of
            section reads as deliberate instead of as a gap. */}
        {clinic.relatedClinics.length > 0 && (
          <section className="border-t border-border bg-surface py-16 md:py-20">
            <div className="max-canvas">
              <h2 className="mb-6 font-serif text-h3 text-ink-primary">Other clinics in {clinic.city}</h2>
              <div className="grid gap-5 md:grid-cols-3">
                {clinic.relatedClinics.map((related) => (
                  <DirectoryClinicCard key={related.id} c={related} sizes={WIDE_CARD_SIZES} />
                ))}
              </div>
            </div>
          </section>
        )}
      </main>

      <BookPill />
      <Footer />
    </>
  )
}

/* formatHoursDisplay and HoursTable lived here until 2026-08-06. The sidebar
   "Hours of operation" card was their only caller, and it was a duplicate once
   ClinicHoursBar started carrying the whole week in its dropdown. */

/* ClinicPhotoGallery moved out to its own file on 2026-08-06 and was deleted on
   2026-08-10 along with the Photos section it rendered. Browsing photos is the
   hero gallery's job now (components/clinics/ClinicCoverPhoto). */

function InstagramIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

function TikTokIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V9.01a8.16 8.16 0 004.78 1.52V7.08a4.85 4.85 0 01-1.01-.39z" />
    </svg>
  )
}

function FacebookIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z" />
    </svg>
  )
}

function LinkedInIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.98 3.5a2.5 2.5 0 11-.02 5 2.5 2.5 0 01.02-5zM3 9h4v12H3zM10 9h3.8v1.7h.05c.53-.95 1.83-1.95 3.77-1.95 4.03 0 4.78 2.5 4.78 5.75V21h-4v-5.6c0-1.34-.03-3.07-1.9-3.07-1.9 0-2.2 1.46-2.2 2.97V21h-4z" />
    </svg>
  )
}

function YouTubeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M23 12s0-3.6-.46-5.33a2.78 2.78 0 00-1.95-1.96C18.88 4.25 12 4.25 12 4.25s-6.88 0-8.59.46A2.78 2.78 0 001.46 6.67C1 8.4 1 12 1 12s0 3.6.46 5.33a2.78 2.78 0 001.95 1.96c1.71.46 8.59.46 8.59.46s6.88 0 8.59-.46a2.78 2.78 0 001.95-1.96C23 15.6 23 12 23 12zM9.75 15.27V8.73L15.5 12z" />
    </svg>
  )
}

/**
 * Every channel we hold for a clinic. LinkedIn and YouTube were added to the
 * schema 2026-08-06 (client request); nothing has been scraped into them yet,
 * so in practice most clinics render Instagram / Facebook / TikTok only.
 *
 * Returns the list rather than rendering it: since 2026-08-10 these links share
 * a row with Save and Share, so the hero owns the layout and this owns the data.
 */
function socialChannels(clinic: ClinicDetail) {
  return [
    { href: clinic.instagramUrl, label: 'Instagram', icon: <InstagramIcon /> },
    { href: clinic.facebookUrl, label: 'Facebook', icon: <FacebookIcon /> },
    { href: clinic.tiktokUrl, label: 'TikTok', icon: <TikTokIcon /> },
    { href: clinic.linkedinUrl, label: 'LinkedIn', icon: <LinkedInIcon /> },
    { href: clinic.youtubeUrl, label: 'YouTube', icon: <YouTubeIcon /> },
  ].filter((c) => !!c.href)
}

/**
 * Detail-row icons. Sized by prop because each one renders twice: 16px inside
 * the desktop label pill, 18px in the bare icon gutter mobile uses instead.
 */
type IconProps = { size?: number }

function PinIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0116 0z" />
      <circle cx="12" cy="10" r="2.75" />
    </svg>
  )
}

function PhoneIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.36 1.9.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0122 16.92z" />
    </svg>
  )
}

function GlobeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 010 18a15 15 0 010-18z" />
    </svg>
  )
}

function MailIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 7l8.5 6 8.5-6" />
    </svg>
  )
}

function ClockIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Clock with a rewind arrow: "last updated", distinct from the Hours clock. */
function HistoryIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M3.05 11a9 9 0 113 7.7" />
      <polyline points="3 6 3 11 8 11" />
      <polyline points="12 8 12 12 14.8 13.7" />
    </svg>
  )
}

/* DirectionsIcon lived here until 2026-08-11. Its only caller was the inline
   "Get directions" chip at the end of the address, which went when the address
   itself became the directions link. */

/**
 * The small bordered chip that opens the rating line and the last-updated line.
 * One icon each, nothing else: the rating itself sits outside the chip, next to
 * it, exactly like the date sits next to the clock (client request 2026-08-11).
 *
 * A first pass put all five stars inside the chip. The client rejected it: the
 * chip is the icon's frame, not the value's.
 *
 * Padded rather than a fixed square (2026-08-11) so its icon starts at the same
 * 9px from the row's left edge as the icons in the detail pills below. Every
 * icon in the column sits on one vertical line.
 */
const RATING_CHIP =
  'inline-flex shrink-0 items-center justify-center rounded-control border border-border bg-surface px-2 py-1.5 transition-colors duration-150 hover:border-brand-accent hover:bg-brand-accent-soft'

/**
 * The rating icon. Drawn, not typed: the old '★'.repeat() rendered whatever
 * glyph the visitor's OS shipped, which is why the row came out uneven on
 * Windows. Stays gold on hover; the chip around it carries the accent.
 */
function StarIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" strokeLinejoin="round">
      <path d="M12 2.6l2.92 5.92 6.53.95-4.72 4.6 1.11 6.5L12 17.52l-5.84 3.07 1.11-6.5-4.72-4.6 6.53-.95z" />
    </svg>
  )
}

/**
 * One line of the hero's clinic details, Google business panel style: a labelled
 * icon pill on the left, the value beside it (client request 2026-08-11).
 *
 * The pill is a fixed 6rem, left justified. Centring was tried first, to spread
 * the leftover width evenly, but it moves the icon by however long the label is:
 * "Hours" pushed its pin right of "Address"'s, so no two icons shared a vertical
 * line. Left justifying puts every icon on one axis and every label on a second,
 * which is what the reviewer asked for; the leftover width now trails inside the
 * pill, 11px after "Address" and 23px after "Hours", which reads as padding
 * rather than as the ~45px gap that got flagged at the old 7rem width.
 *
 * It uses rounded-control like the rest of the site. Not rounded-full: the
 * client rejected oval corners as an AI-generated tell (see CLAUDE.md radii).
 *
 * Below sm the pill is dropped for a bare icon gutter, which is what Google's
 * own mobile panel does. A 360px screen only clears ~320px, and spending 96px
 * of that on a label wraps the address to three lines and pushes the Hours
 * dropdown (290px wide) off the right edge of the page. Stacking the pill above
 * its value was tried first and read loose, so the label goes instead: the icon
 * already says what the row is.
 */
function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: ComponentType<IconProps>
  label: string
  children: ReactNode
}) {
  return (
    <div className="group flex items-start gap-2.5 sm:gap-3">
      <span className="mt-[3px] shrink-0 text-ink-tertiary transition-colors duration-150 group-hover:text-brand-accent sm:hidden">
        <Icon size={18} />
      </span>
      {/* Hover is driven by the whole row, not the pill: the pill is a label,
          and lighting it up only when the cursor is exactly on it would be a
          target nobody aims at. */}
      <span className="hidden w-24 shrink-0 items-center justify-start gap-1.5 rounded-control border border-border bg-surface px-2 py-1.5 text-caption font-semibold text-ink-secondary transition-colors duration-150 group-hover:border-brand-accent group-hover:bg-brand-accent-soft group-hover:text-brand-accent sm:inline-flex">
        <span className="shrink-0 text-ink-tertiary transition-colors duration-150 group-hover:text-brand-accent">
          <Icon size={16} />
        </span>
        {label}
      </span>
      <div className="min-w-0 flex-1 sm:pt-[3px]">{children}</div>
    </div>
  )
}

/** "https://www.davamaesthetics.com/" reads better as "davamaesthetics.com". */
function displayUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
  }
}

function ReviewsSection({ clinic }: { clinic: ClinicDetail }) {
  const reviewCount = clinic.aggregateRatingCount ?? clinic.reviews.length
  const averageLabel = clinic.aggregateRating ? `${clinic.aggregateRating.toFixed(1)} average` : 'Average pending'

  return (
    <section>
      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-serif text-h3 text-ink-primary">Reviews</h2>
          <p className="mt-1 text-body-sm text-ink-secondary">
            {averageLabel} from {reviewCount.toLocaleString()} approved {reviewCount === 1 ? 'review' : 'reviews'}.
          </p>
        </div>
      </div>
      <div className="space-y-4">
        {clinic.reviews.map((review) => (
          <ReviewCard key={review.id} review={review} />
        ))}
      </div>
    </section>
  )
}

function ReviewCard({ review }: { review: ClinicDetail['reviews'][number] }) {
  const displayText = reviewDisplayText(review)

  return (
    <article className="rounded-2xl border border-border bg-surface p-5 md:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="star-row text-[14px] text-state-star">{renderStars(review.rating)}</span>
            <span className="text-body-sm font-semibold text-ink-primary">{review.rating.toFixed(1)}</span>
            {review.reviewDate && (
              <time className="text-body-sm text-ink-tertiary" dateTime={review.reviewDate}>
                {formatReviewDate(review.reviewDate)}
              </time>
            )}
          </div>
          {review.title && (
            <h3 className="mt-2 text-body font-semibold text-ink-primary">{review.title}</h3>
          )}
        </div>
        {review.serviceTag && (
          <span className="shrink-0 rounded-control border border-border px-3 py-1 text-caption font-semibold text-ink-tertiary">
            {review.serviceTag}
          </span>
        )}
      </div>

      {displayText && (
        <p className="mt-4 text-body-sm leading-relaxed text-ink-secondary">{displayText}</p>
      )}

      {(review.attributionRequired && review.sourcePlatform) && (
        <p className="mt-4 text-caption text-ink-tertiary">
          via{' '}
          {review.sourceUrl ? (
            <a
              href={review.sourceUrl}
              target="_blank"
              rel="nofollow noopener"
              className="font-semibold text-brand-accent hover:underline"
            >
              {formatSourceLabel(review.sourcePlatform)}
            </a>
          ) : (
            <span className="font-semibold">{formatSourceLabel(review.sourcePlatform)}</span>
          )}
        </p>
      )}

      {review.responseFromProvider && (
        <div className="mt-4 rounded-xl border border-border-subtle bg-surface-canvas p-4">
          <p className="text-caption font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
            Clinic response{review.responseDate ? `, ${formatReviewDate(review.responseDate)}` : ''}
          </p>
          <p className="mt-2 text-body-sm leading-relaxed text-ink-secondary">{review.responseFromProvider}</p>
        </div>
      )}
    </article>
  )
}

function buildSchema(clinic: ClinicDetail, canonicalUrl: string, faqs: ClinicFaq[]): object[] {
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Clinics', item: `${SITE_URL}/clinics` },
      { '@type': 'ListItem', position: 3, name: titleFromSlug(clinic.stateSlug), item: `${SITE_URL}/clinics/${clinic.stateSlug}` },
      { '@type': 'ListItem', position: 4, name: clinic.city, item: `${SITE_URL}/clinics/${clinic.stateSlug}/${clinic.citySlug}` },
      { '@type': 'ListItem', position: 5, name: clinic.clinicName, item: canonicalUrl },
    ],
  }

  const socialLinks = [clinic.websiteUrl, clinic.instagramUrl, clinic.tiktokUrl, clinic.facebookUrl].filter(Boolean)

  const medicalBusiness: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': ['MedicalBusiness', 'LocalBusiness', 'HealthAndBeautyBusiness'],
    name: clinic.clinicName,
    description: clinic.description || clinic.tagline,
    image: clinic.photoUrls,
    url: canonicalUrl,
    mainEntityOfPage: webPageRef(canonicalUrl),
    telephone: formatPhoneDisplay(clinic.phone) ?? clinic.phone,
    email: clinic.email,
    address: {
      '@type': 'PostalAddress',
      streetAddress: [clinic.addressLine1, clinic.addressLine2].filter(Boolean).join(', '),
      addressLocality: clinic.city,
      addressRegion: clinic.state,
      postalCode: clinic.zip,
      addressCountry: 'US',
    },
    geo: hasValidCoordinates(clinic.latitude, clinic.longitude)
      ? {
          '@type': 'GeoCoordinates',
          latitude: clinic.latitude,
          longitude: clinic.longitude,
        }
      : undefined,
    openingHours: openingHoursSchema(clinic.hoursJson),
    priceRange: clinic.startingPrice ? `From $${clinic.startingPrice}` : '$$',
    sameAs: socialLinks.length > 0 ? socialLinks : undefined,
    paymentAccepted: clinic.paymentMethods
      ? clinic.paymentMethods.split(';').map((v) => v.trim()).filter(Boolean).join(', ')
      : undefined,
  }

  if (clinic.aggregateRating) {
    medicalBusiness.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: clinic.aggregateRating,
      reviewCount: clinic.aggregateRatingCount || 0,
      bestRating: 5,
      worstRating: 1,
    }
  }

  if (clinic.reviews.length > 0) {
    medicalBusiness.review = clinic.reviews.map((review) =>
      stripUndefined({
        '@type': 'Review',
        name: review.title,
        reviewBody: reviewDisplayText(review),
        datePublished: review.reviewDate,
        reviewRating: {
          '@type': 'Rating',
          ratingValue: review.rating,
          bestRating: 5,
          worstRating: 1,
        },
        publisher: review.sourcePlatform
          ? {
              '@type': 'Organization',
              name: formatSourceLabel(review.sourcePlatform),
            }
          : undefined,
      }),
    )
  }

  const items: object[] = [breadcrumb, stripUndefined(medicalBusiness)]

  if (faqs.length > 0) {
    items.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map((faq) => ({
        '@type': 'Question',
        name: faq.question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: faq.detail ? `${faq.answer} ${faq.detail}` : faq.answer,
        },
      })),
    })
  }

  return items
}

function buildFallbackFaqs(clinic: ClinicDetail): ClinicFaq[] {
  const faqs: ClinicFaq[] = []

  const serviceNames = clinic.servicesOffered.map((s) => s.name)
  const brandNames = clinic.brandsOffered.map((b) => b.name)
  if (serviceNames.length > 0 || brandNames.length > 0) {
    const parts: string[] = []
    if (serviceNames.length > 0) {
      // "including" with a count only reads correctly when the list really is a
      // subset. At four or fewer the sentence named every service and still
      // said "including", which reads as an error on a page that lists all of
      // them a screen below. See docs/LISTING-FIX-PLAN-2026-09-19.md TASK 4.
      const shown = serviceNames.slice(0, 4)
      const plural = serviceNames.length === 1 ? '' : 's'
      parts.push(
        serviceNames.length > shown.length
          ? `${clinic.clinicName} offers ${serviceNames.length} service${plural} including ${shown.join(', ')}.`
          : `${clinic.clinicName} offers ${serviceNames.length} service${plural}: ${shown.join(', ')}.`,
      )
    }
    if (brandNames.length > 0) {
      parts.push(`Brands offered include ${brandNames.join(', ')}.`)
    }
    parts.push('See the full list in the treatments section on this page.')
    faqs.push({
      id: 'auto-treatments',
      question: `What treatments does ${clinic.clinicName} offer?`,
      answer: parts.join(' '),
    })
  }

  if (clinic.aggregateRating && clinic.aggregateRatingCount) {
    faqs.push({
      id: 'auto-rating',
      question: `How is ${clinic.clinicName} rated?`,
      answer: `${clinic.clinicName} has a ${clinic.aggregateRating.toFixed(1)} star rating based on ${clinic.aggregateRatingCount.toLocaleString()} patient reviews.`,
    })
  }

  faqs.push({
    id: 'auto-location',
    question: `Where is ${clinic.clinicName} located?`,
    answer: `${clinic.clinicName} is located at ${fullAddress(clinic)}.${clinic.hoursJson ? ' See the hours of operation on this page before you visit.' : ''}`,
  })

  return faqs
}

function fullAddress(clinic: ClinicDetail): string {
  return [
    clinic.addressLine1,
    clinic.addressLine2,
    clinic.neighborhood,
    clinic.city,
    `${clinic.state} ${clinic.zip}`.trim(),
  ].filter(Boolean).join(', ')
}

function hasValidCoordinates(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude !== 0 && longitude !== 0
}

/* hoursToday / nextOpening / parseHoursRange / toMinutes / formatMinutes lived
   here until 2026-08-06. The quick-info bar was their only caller; the live
   open/closed logic now runs client-side in components/clinics/ClinicHoursBar,
   where it can read the visitor's own clock instead of the server's. */

function openingHoursSchema(hours?: ClinicHours): string[] | undefined {
  if (!hours) return undefined
  const dayCodes: Record<(typeof DAY_KEYS)[number], string> = {
    mon: 'Mo',
    tue: 'Tu',
    wed: 'We',
    thu: 'Th',
    fri: 'Fr',
    sat: 'Sa',
    sun: 'Su',
  }
  const rows = DAY_KEYS
    .map((day) => {
      const value = hours[day]
      if (!value || /^closed$/i.test(value)) return null
      return `${dayCodes[day]} ${value}`
    })
    .filter(Boolean) as string[]
  return rows.length > 0 ? rows : undefined
}

function reviewDisplayText(review: ClinicDetail['reviews'][number]): string | undefined {
  if (review.publishStatus === 'hidden') return undefined
  if (review.publishStatus === 'full') return review.text || review.excerpt || undefined
  if (review.excerpt) return review.excerpt
  return review.text ? truncate(review.text, 200) : undefined
}

function renderStars(rating: number): string {
  const rounded = Math.max(0, Math.min(5, Math.round(rating)))
  return `${'★'.repeat(rounded)}${'☆'.repeat(5 - rounded)}`
}

function formatReviewDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatSourceLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** Lowercase on purpose: this one reads mid-sentence in the meta description. */
function formatClinicType(type?: string): string {
  const labels: Record<string, string> = {
    medspa: 'med spa',
    dermatology: 'dermatology clinic',
    'plastic-surgery': 'plastic surgery clinic',
    'dental-aesthetics': 'dental aesthetics clinic',
    other: 'aesthetic clinic',
  }
  return type ? labels[type] ?? 'aesthetic clinic' : 'aesthetic clinic'
}

/* clinicTypeChipLabel lived here until 2026-08-10. Its only caller was the
   "Med Spa" chip above the clinic name, which the client removed from the front
   end. formatClinicType stays: the meta description still uses it. */

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1).trim()}...`
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
}

function safeJson(value: object): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
