import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Header } from '@/components/header/Header'
import { Footer } from '@/components/footer/Footer'
import { getGuideBySlug, getAllApprovedGuideSlugs } from '@/lib/guide-queries'
import { getFaqPreview } from '@/lib/faqs/queries'
import { FaqBlock } from '@/components/faq/FaqBlock'
import { RenderLexical, extractHeadings } from '@/lib/render-lexical'
import { ServiceIndices } from '@/components/shared/ServiceIndices'
import { WorthItBadge } from '@/components/shared/WorthItBadge'
import { getWorthItScore } from '@/lib/worth-it'
import { FaqAccordionItem } from '@/components/shared/FaqAccordionItem'
import { AtAGlanceList } from '@/components/shared/AtAGlanceList'
import { TableOfContents } from '@/components/shared/TableOfContents'
import { getEntityRobots } from '@/lib/page-index/queries'
import { resolveGuideDates, formatGuideDate } from '@/lib/guide-dates'
import { buildPageMetadata } from '@/lib/seo-metadata'
import { webPageRef, articleAuthor } from '@/lib/json-ld'

export const revalidate = 300

export async function generateStaticParams() {
  try {
    const slugs = await getAllApprovedGuideSlugs()
    return slugs.map((slug) => ({ slug }))
  } catch {
    return []
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const guide = await getGuideBySlug(slug)
  if (!guide) return {}

  // Client's 2026-09-18 document: guide titles carry a dash suffix, not the pipe
  // the directory pages use. All 100 guides have their own meta title and none of
  // them contains the brand, so nothing double-brands.
  // See docs/SEO-TITLES-DESCRIPTIONS-2026-09-18.md.
  const title = `${guide.meta?.title || guide.title} - Injector.World`
  const description = guide.meta?.description || guide.excerpt || guide.lede
  const imageUrl = guide.meta?.image?.url || guide.coverImageUrl
  // From the env, not a literal: production serves www.injector.world and the
  // apex 301s to it, so a hardcoded apex canonical pointed at a redirect.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://injector.world'
  const url = `${siteUrl}/guides/${guide.slug}`

  // Indexability now resolves from the url registry (page_index), same as every
  // other page type, rather than from this collection's own indexState field.
  // A guide is indexed once it has been batched in from the admin Indexing
  // screen; until then it is crawlable but noindex, so internal links are still
  // discovered. `nofollow` is intentionally no longer consulted: it duplicated
  // the same gate and could emit a tag that contradicted the registry.
  const robots = await getEntityRobots('guides', guide.id)
  const dates = resolveGuideDates(guide.publishedAt, guide.contentUpdatedAt)

  return buildPageMetadata({
    title,
    description,
    url,
    image: imageUrl ? { url: imageUrl } : null,
    imageAlt: guide.title,
    robots,
    // Same two values as the visible byline and the JSON-LD below. See
    // docs/GUIDE-DATES-2026-09-13.md.
    article: {
      publishedTime: dates.published,
      modifiedTime: dates.modified,
      authors: [guide.author.fullName],
    },
  })
}

export default async function GuideDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const guide = await getGuideBySlug(slug)
  if (!guide) notFound()

  const [faqBlock, worthIt] = await Promise.all([
    // Preview of the FAQ categories linked to this guide. Since 2026-09-13 the
    // full set and its FAQPage schema live on /faq/<category>, not here.
    getFaqPreview({ field: 'guides', id: guide.id }),
    guide.relatedService
      ? getWorthItScore(guide.relatedService.name)
      : Promise.resolve({ score: 0, sampleSize: 0, hasData: false }),
  ])

  const dates = resolveGuideDates(guide.publishedAt, guide.contentUpdatedAt)

  const tocHeadings = extractHeadings(guide.body)

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://injector.world'

  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': ['MedicalWebPage', 'Article'],
    headline: guide.title,
    description: guide.excerpt || guide.lede,
    ...(guide.coverImageUrl
      ? {
          image: {
            '@type': 'ImageObject',
            url: guide.coverImageUrl,
            ...(guide.coverImageWidth ? { width: guide.coverImageWidth } : {}),
            ...(guide.coverImageHeight ? { height: guide.coverImageHeight } : {}),
            ...(guide.coverImageAlt ? { caption: guide.coverImageAlt } : {}),
          },
        }
      : {}),
    url: `${siteUrl}/guides/${guide.slug}`,
    mainEntityOfPage: webPageRef(`${siteUrl}/guides/${guide.slug}`),
    ...(dates.published ? { datePublished: dates.published } : {}),
    ...(dates.modified ? { dateModified: dates.modified } : {}),
    // Organization for the house byline, Person for a named author (SEO expert
    // spec 2026-10-05: Person + EEAT once real authors are assigned).
    author: articleAuthor(guide.author, siteUrl),
    publisher: {
      '@type': 'Organization',
      name: 'injector.world',
      url: siteUrl,
    },
    articleSection: 'Guides',
    ...(guide.medicalReviewer
      ? {
          reviewedBy: {
            '@type': 'Person',
            name: guide.medicalReviewer.fullName,
            honorificSuffix: guide.medicalReviewer.credentials,
          },
        }
      : {}),
    ...(guide.relatedService ? { specialty: 'Dermatology' } : {}),
  }

  // Augment FAQs with treatment indices for AEO/featured snippets
  const indicesFaqs: { question: string; answer: string }[] = []
  if (guide.relatedService) {
    const t = guide.relatedService
    if (t.longevityLabel) {
      indicesFaqs.push({ question: `How long does ${t.name} last?`, answer: `${t.name} typically lasts ${t.longevityLabel}.` })
    }
    if (t.downtimeLabel) {
      indicesFaqs.push({ question: `What is the recovery time for ${t.name}?`, answer: `Most patients experience ${t.downtimeLabel} of downtime after ${t.name}.` })
    }
    if (t.painIndex != null) {
      indicesFaqs.push({ question: `Is ${t.name} painful?`, answer: `${t.name} is rated ${t.painIndex} out of 10 on the pain scale. Most patients describe it as mild to moderate discomfort.` })
    }
  }
  // Schema covers the guide's own content only: indicesFaqs + inline guide.faq[].
  // Collection FAQs shown in the preview below carry their schema on
  // /faq/<category> (docs/FAQ-SYSTEM-2026-09-13.md), so they are not repeated here.
  const inlineFaqsForSchema = Array.isArray(guide.faq)
    ? guide.faq.map((f) => ({ question: f.question, answer: f.answer, detail: f.detail }))
    : []
  const allFaqsForSchema = [
    ...indicesFaqs.map((f) => ({ ...f, detail: undefined as string | undefined })),
    ...inlineFaqsForSchema,
  ]

  const faqSchema =
    allFaqsForSchema.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: allFaqsForSchema.map((f) => ({
            '@type': 'Question',
            name: f.question,
            acceptedAnswer: {
              '@type': 'Answer',
              text: f.detail ? `${f.answer} ${f.detail}` : f.answer,
            },
          })),
        }
      : null

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
      { '@type': 'ListItem', position: 2, name: 'Guides', item: `${siteUrl}/guides` },
      { '@type': 'ListItem', position: 3, name: guide.title },
    ],
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema).replace(/</g, '\\u003c') }}
      />
      {faqSchema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema).replace(/</g, '\\u003c') }}
        />
      )}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema).replace(/</g, '\\u003c') }}
      />

      <Header />

      {/* Breadcrumb */}
      <div className="bg-surface border-b border-border">
        <div className="max-canvas py-3">
          <nav
            className="flex items-center gap-2 text-caption text-ink-tertiary"
            aria-label="Breadcrumb"
          >
            <Link href="/" className="hover:text-ink-primary transition">
              Home
            </Link>
            <span>/</span>
            <Link href="/guides" className="hover:text-ink-primary transition">
              Guides
            </Link>
            <span>/</span>
            <span className="text-ink-primary truncate max-w-[200px] md:max-w-none">
              {guide.title}
            </span>
          </nav>
        </div>
      </div>

      {/* Article hero */}
      <section className="bg-surface-warm pt-6 pb-10 md:pt-8 md:pb-12">
        <div className="max-canvas">
          <div className="max-w-3xl mx-auto text-center">
            <h1 className="font-serif text-h1-m md:text-h1 font-medium leading-tight tracking-tight text-ink-primary mb-5 text-balance">
              {guide.title}
            </h1>

            <p className="font-serif text-lede-m md:text-lede text-ink-secondary leading-relaxed text-balance">
              {guide.lede}
            </p>
          </div>
        </div>
      </section>

      {/* Main content + sidebar */}
      <section className="pt-8 pb-20 md:pt-11 md:pb-28 bg-surface-canvas">
        <div className="max-canvas">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-10 lg:gap-14 items-start">

            {/* Left: article body + FAQs + reviewer card */}
            <div>
              {/* Compact byline: published + updated dates and author, sits right above the cover image */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-tertiary mb-3">
                {dates.published && (
                  <>
                    <span>
                      <span className="font-medium text-ink-secondary">Published</span>{' '}
                      <time dateTime={dates.published}>{formatGuideDate(dates.published)}</time>
                    </span>
                    <span>·</span>
                  </>
                )}
                {dates.showUpdated && dates.modified && (
                  <>
                    <span>
                      <span className="font-medium text-ink-secondary">Updated</span>{' '}
                      <time dateTime={dates.modified}>{formatGuideDate(dates.modified)}</time>
                    </span>
                    <span>·</span>
                  </>
                )}
                <span>{guide.author.fullName}</span>
                {guide.medicalReviewer && (
                  <>
                    <span>·</span>
                    <span className="text-brand-accent font-medium">
                      Medically reviewed by {guide.medicalReviewer.fullName}
                    </span>
                  </>
                )}
                {guide.readTimeMin && (
                  <>
                    <span>·</span>
                    <span>{guide.readTimeMin} min read</span>
                  </>
                )}
              </div>

              {/* Cover image (sits above the left column only, not full page width) */}
              {guide.coverImageUrl && (
                <div className="relative w-full aspect-[16/9] rounded-xl overflow-hidden shadow-md mb-8">
                  <Image
                    src={guide.coverImageUrl}
                    alt={guide.title}
                    fill
                    sizes="(min-width: 1024px) 780px, 100vw"
                    className="object-cover"
                    priority
                  />
                </div>
              )}

              {/* Answer snippet */}
              {guide.answerSnippet && (
                <div className="mb-8 rounded-xl border border-brand-accent-soft bg-brand-accent-soft/40 p-5">
                  <div className="text-caption text-brand-accent font-semibold uppercase tracking-wider mb-2">
                    Quick answer
                  </div>
                  <p className="text-body text-ink-primary leading-relaxed">{guide.answerSnippet}</p>
                </div>
              )}

              {/* At a glance (inline structured facts from importer) */}
              {guide.atAGlance && guide.atAGlance.length > 0 && <AtAGlanceList facts={guide.atAGlance} />}

              {guide.body ? (
                <RenderLexical content={guide.body} />
              ) : (
                <div className="prose-guide">
                  <p>
                    This guide is being expanded by our editorial team. The full article will be
                    available soon. In the meantime, the FAQ section below covers the most
                    common questions.
                  </p>
                </div>
              )}

              {/* Inline faq[] from the importer: part of this guide's own content. */}
              {guide.faq && guide.faq.length > 0 && (
                <div className="mt-12">
                  <h2 className="font-serif text-h3 text-ink-primary mb-6">
                    Frequently asked questions
                  </h2>
                  <div className="space-y-2">
                    {guide.faq.map((f, i) => (
                      <FaqAccordionItem
                        key={`inline-${i}`}
                        question={f.question}
                        answer={f.answer}
                        detail={f.detail}
                        offLabel={f.offLabel}
                        safetyFlag={f.safetyFlag}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Preview of the FAQ categories linked to this guide, with a link to the full page. */}
              <FaqBlock
                faqs={faqBlock.faqs}
                seeAll={faqBlock.seeAll}
                heading={guide.faq && guide.faq.length > 0 ? 'More common questions' : 'Frequently asked questions'}
                className="mt-12"
                headingClassName="font-serif text-h3 text-ink-primary mb-6"
                listClassName="space-y-2"
              />

              {/* Detailed sources list from importer */}
              {guide.sources && guide.sources.length > 0 ? (
                <div className="mt-10 rounded-xl border border-border bg-surface p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="rgb(var(--brand-accent))"
                      strokeWidth="2"
                    >
                      <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" />
                      <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
                    </svg>
                    <span className="text-body-sm font-semibold text-ink-primary">
                      Sources ({guide.sources.length})
                    </span>
                  </div>
                  <ol className="space-y-3">
                    {guide.sources.map((s, i) => (
                      <li key={i} className="flex gap-3 text-body-sm text-ink-secondary">
                        <span className="flex-shrink-0 font-semibold text-ink-tertiary">{i + 1}.</span>
                        <span>
                          {s.url ? (
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer nofollow"
                              className="font-medium text-brand-accent hover:underline"
                            >
                              {s.title}
                            </a>
                          ) : (
                            <span className="font-medium text-ink-primary">{s.title}</span>
                          )}
                          {s.publisher && <span className="text-ink-tertiary"> — {s.publisher}</span>}
                          {s.publishedDate && (
                            <span className="text-ink-tertiary"> ({s.publishedDate})</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : guide.sourcesCount && guide.sourcesCount > 0 ? (
                <div className="mt-10 flex items-start gap-3 p-4 rounded-lg border border-border bg-surface text-body-sm text-ink-secondary">
                  <svg
                    className="flex-shrink-0 mt-0.5"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="rgb(var(--brand-accent))"
                    strokeWidth="2"
                  >
                    <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" />
                    <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
                  </svg>
                  <span>
                    This guide cites{' '}
                    <span className="font-medium text-ink-primary">
                      {guide.sourcesCount} sources
                    </span>
                    . Our editorial team and medical reviewers verify source quality before
                    publication.{' '}
                    <Link href="/editorial-standards" className="text-brand-accent hover:underline">
                      Editorial standards
                    </Link>
                  </span>
                </div>
              ) : null}

              {/* Medical reviewer credentials card */}
              {guide.medicalReviewer && (
                <div className="mt-10 rounded-2xl border border-border bg-surface p-6">
                  <div className="flex items-start gap-4">
                    {guide.medicalReviewer.photoUrl && (
                      <div className="relative w-14 h-14 rounded-full overflow-hidden flex-shrink-0 border-2 border-brand-accent">
                        <Image
                          src={guide.medicalReviewer.photoUrl}
                          alt={guide.medicalReviewer.fullName}
                          fill
                          sizes="56px"
                          className="object-cover"
                        />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-caption text-brand-accent font-semibold uppercase tracking-wider mb-1">
                        Medically reviewed by
                      </div>
                      <div className="font-semibold text-body text-ink-primary">
                        {guide.medicalReviewer.fullName}, {guide.medicalReviewer.credentials}
                      </div>
                      {guide.medicalReviewer.title && (
                        <div className="text-body-sm text-ink-secondary">
                          {guide.medicalReviewer.title}
                        </div>
                      )}
                      {guide.medicalReviewer.boardCertifications &&
                        guide.medicalReviewer.boardCertifications.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {guide.medicalReviewer.boardCertifications.map((cert) => (
                              <span
                                key={cert}
                                className="inline-flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1 rounded-control bg-brand-accent-soft text-brand-accent"
                              >
                                <svg
                                  width="9"
                                  height="9"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="3"
                                >
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                                {cert}
                              </span>
                            ))}
                          </div>
                        )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Right: sidebar */}
            <div className="space-y-5 lg:sticky lg:top-24">
              {/* Treatment at a glance */}
              {guide.relatedService && (worthIt.hasData || guide.relatedService.painIndex != null || guide.relatedService.longevityLabel || guide.relatedService.downtimeLabel) && (
                <div className="rounded-2xl border border-border bg-surface p-5">
                  <h3 className="text-h4 text-ink-primary mb-3">At a glance</h3>
                  {worthIt.hasData && (
                    <div className="mb-3">
                      <WorthItBadge result={worthIt} serviceName={guide.relatedService.name} />
                    </div>
                  )}
                  <ServiceIndices
                    painIndex={guide.relatedService.painIndex}
                    longevityLabel={guide.relatedService.longevityLabel}
                    downtimeLabel={guide.relatedService.downtimeLabel}
                    className="flex-col"
                  />
                </div>
              )}

              {/* Find provider CTA */}
              {guide.relatedService && (
                <div className="rounded-2xl border border-border bg-surface-warm p-6">
                  <div className="flex items-center gap-1.5 mb-3">
                    <svg
                      className="text-brand-accent"
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <span className="text-overline uppercase tracking-widest font-semibold text-brand-accent">
                      Find a provider
                    </span>
                  </div>
                  <h3 className="font-serif text-h3 text-ink-primary mb-2 leading-snug">
                    Find a verified {guide.relatedService.name} injector near you
                  </h3>
                  {guide.relatedService.tagline && (
                    <p className="text-body-sm text-ink-secondary mb-4">
                      {guide.relatedService.tagline}
                    </p>
                  )}
                  <Link
                    href={`/services/${guide.relatedService.slug}`}
                    className="flex w-full items-center justify-center gap-2 bg-brand-primary text-surface-canvas rounded-control py-3 text-body-sm font-semibold hover:opacity-90 transition"
                  >
                    Browse providers
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </Link>
                </div>
              )}

              {/* Table of contents (replaces the "About this guide" + disclaimer
                  cards, 2026-09-03 founder request) */}
              <TableOfContents headings={tocHeadings} />
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </>
  )
}

