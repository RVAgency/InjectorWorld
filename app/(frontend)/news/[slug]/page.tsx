import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Header } from '@/components/header/Header'
import { Footer } from '@/components/footer/Footer'
import { RenderLexical, extractHeadings } from '@/lib/render-lexical'
import { getNewsBySlug, getAllApprovedNewsSlugs } from '@/lib/news-queries'
import { AtAGlanceList } from '@/components/shared/AtAGlanceList'
import { TableOfContents } from '@/components/shared/TableOfContents'
import { getEntityRobots } from '@/lib/page-index/queries'
import { buildPageMetadata } from '@/lib/seo-metadata'
import { webPageRef, articleAuthor } from '@/lib/json-ld'

export const revalidate = 300

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://injector.world'

export async function generateStaticParams() {
  try {
    const slugs = await getAllApprovedNewsSlugs()
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
  const article = await getNewsBySlug(slug)
  if (!article) return {}

  const title = `${article.title} | Injector.World`
  const description = article.excerpt
  const imageUrl = article.coverImageUrl
  const url = `${siteUrl}/news/${article.slug}`

  // Indexability now resolves from the url registry (page_index), same as every
  // other page type, rather than from this collection's own indexState field.
  // See the matching comment in the guides page.
  const robots = await getEntityRobots('news', article.id)

  return buildPageMetadata({
    title,
    description,
    url,
    image: imageUrl ? { url: imageUrl } : null,
    imageAlt: article.title,
    robots,
    alternateTypes: { 'application/rss+xml': `${siteUrl}/news/rss.xml` },
    article: {
      publishedTime: article.publishedAt,
      modifiedTime: article.updatedAt || article.publishedAt,
      authors: [article.author.fullName],
    },
  })
}

export default async function NewsDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const article = await getNewsBySlug(slug)
  if (!article) notFound()

  const publishedFormatted = article.publishedAt
    ? new Date(article.publishedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null

  const tocHeadings = extractHeadings(article.body)


  // Build FAQPage JSON-LD from inline faq array
  const faqSchema =
    article.faq && article.faq.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: article.faq.map((f) => ({
            '@type': 'Question',
            name: f.question,
            acceptedAnswer: { '@type': 'Answer', text: f.answer },
          })),
        }
      : null

  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: article.title,
    description: article.excerpt,
    ...(article.coverImageUrl ? { image: article.coverImageUrl } : {}),
    url: `${siteUrl}/news/${article.slug}`,
    mainEntityOfPage: webPageRef(`${siteUrl}/news/${article.slug}`),
    ...(article.publishedAt ? { datePublished: article.publishedAt } : {}),
    // Real last-modified first: it bumps on every content change (including an
    // approved internal-link insertion), which is the freshness signal.
    // publishedAt is only a fallback and is never overwritten.
    ...(article.updatedAt || article.publishedAt
      ? { dateModified: article.updatedAt || article.publishedAt }
      : {}),
    // Organization for the house byline, Person for a named author (SEO expert
    // spec 2026-10-05: Person + EEAT once real authors are assigned).
    author: articleAuthor(article.author, siteUrl),
    publisher: {
      '@type': 'Organization',
      name: 'injector.world',
      url: siteUrl,
      logo: {
        '@type': 'ImageObject',
        // Was /logo.png, a file that has never existed in public/ (404).
        url: `${siteUrl}/wordmark.png`,
      },
    },
    articleSection: 'News',
    ...(article.medicalReviewer
      ? {
          reviewedBy: {
            '@type': 'Person',
            name: article.medicalReviewer.fullName,
            honorificSuffix: article.medicalReviewer.credentials,
          },
        }
      : {}),
  }

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
      { '@type': 'ListItem', position: 2, name: 'News', item: `${siteUrl}/news` },
      { '@type': 'ListItem', position: 3, name: article.title },
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
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbSchema).replace(/</g, '\\u003c'),
        }}
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
            <Link href="/news" className="hover:text-ink-primary transition">
              News
            </Link>
            <span>/</span>
            <span className="text-ink-primary truncate max-w-[200px] md:max-w-none">
              {article.title}
            </span>
          </nav>
        </div>
      </div>

      {/* Article hero */}
      <section className="bg-surface-warm pt-6 pb-10 md:pt-8 md:pb-12">
        <div className="max-canvas">
          <div className="max-w-3xl mx-auto text-center">
            <h1 className="font-serif text-h1-m md:text-h1 font-medium leading-tight tracking-tight text-ink-primary mb-5 text-balance">
              {article.title}
            </h1>

            <p className="font-serif text-lede-m md:text-lede text-ink-secondary leading-relaxed text-balance">
              {article.excerpt}
            </p>
          </div>
        </div>
      </section>

      {/* Main content + sidebar */}
      <section className="pt-8 pb-20 md:pt-11 md:pb-28 bg-surface-canvas">
        <div className="max-canvas">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-10 lg:gap-14 items-start">
            {/* Article body */}
            <div>
              {/* Compact byline: author + published date, sits right above the cover image */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-tertiary mb-3">
                {publishedFormatted && (
                  <span>
                    <span className="font-medium text-ink-secondary">Published</span>{' '}
                    {publishedFormatted}
                  </span>
                )}
                {publishedFormatted && <span>·</span>}
                <span>{article.author.fullName}</span>
                {article.medicalReviewer && (
                  <>
                    <span>·</span>
                    <span className="text-brand-accent font-medium">
                      Medically reviewed by {article.medicalReviewer.fullName}
                    </span>
                  </>
                )}
              </div>

              {/* Cover image (sits above the left column only, not full page width) */}
              {article.coverImageUrl && (
                <div className="relative w-full aspect-[16/9] rounded-xl overflow-hidden shadow-md mb-8">
                  <Image
                    src={article.coverImageUrl}
                    alt={article.title}
                    fill
                    sizes="(min-width: 1024px) 780px, 100vw"
                    className="object-cover"
                    priority
                  />
                </div>
              )}

              {/* Answer snippet */}
              {article.answerSnippet && (
                <div className="mb-8 rounded-xl border border-brand-accent-soft bg-brand-accent-soft/40 p-5">
                  <div className="text-caption text-brand-accent font-semibold uppercase tracking-wider mb-2">
                    Quick answer
                  </div>
                  <p className="text-body text-ink-primary leading-relaxed">{article.answerSnippet}</p>
                </div>
              )}

              {/* At a glance */}
              {article.atAGlance && article.atAGlance.length > 0 && <AtAGlanceList facts={article.atAGlance} />}

              {/* Lexical body */}
              {article.body ? (
                <RenderLexical content={article.body} />
              ) : (
                <div className="prose-guide">
                  <p>
                    This article is being finalized by our editorial team and will be published
                    shortly.
                  </p>
                </div>
              )}

              {/* FAQ accordion */}
              {article.faq && article.faq.length > 0 && (
                <div className="mt-12">
                  <h2 className="font-serif text-h3 text-ink-primary mb-6">
                    Frequently asked questions
                  </h2>
                  <div className="space-y-2">
                    {article.faq.map((f, i) => (
                      <FaqAccordionItem key={i} question={f.question} answer={f.answer} />
                    ))}
                  </div>
                </div>
              )}

              {/* Sources / citations */}
              {article.sources && article.sources.length > 0 && (
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
                      Sources ({article.sources.length})
                    </span>
                  </div>
                  <ol className="space-y-3">
                    {article.sources.map((s, i) => (
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
              )}

              {/* Medical reviewer card */}
              {article.medicalReviewer && (
                <div className="mt-10 rounded-2xl border border-border bg-surface p-6">
                  <div className="flex items-start gap-4">
                    {article.medicalReviewer.photoUrl && (
                      <div className="relative w-14 h-14 rounded-full overflow-hidden flex-shrink-0 border-2 border-brand-accent">
                        <Image
                          src={article.medicalReviewer.photoUrl}
                          alt={article.medicalReviewer.fullName}
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
                        {article.medicalReviewer.fullName}, {article.medicalReviewer.credentials}
                      </div>
                      {article.medicalReviewer.title && (
                        <div className="text-body-sm text-ink-secondary">
                          {article.medicalReviewer.title}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-5 lg:sticky lg:top-24">
              {/* Related treatment */}
              {article.relatedService && (
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
                      Related
                    </span>
                  </div>
                  <h3 className="font-serif text-h3 text-ink-primary mb-2 leading-snug">
                    Find a verified {article.relatedService.name} injector near you
                  </h3>
                  {article.relatedService.tagline && (
                    <p className="text-body-sm text-ink-secondary mb-4">
                      {article.relatedService.tagline}
                    </p>
                  )}
                  <Link
                    href={`/services/${article.relatedService.slug}`}
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

              {/* Table of contents (replaces the "About this article" + disclaimer
                  cards, 2026-09-03 founder request) */}
              <TableOfContents headings={tocHeadings} />

              {/* RSS link */}
              <div className="flex items-center gap-2 text-caption text-ink-tertiary">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M4 11a9 9 0 019 9" />
                  <path d="M4 4a16 16 0 0116 16" />
                  <circle cx="5" cy="19" r="1" />
                </svg>
                <Link href="/news/rss.xml" className="hover:text-brand-accent transition">
                  Subscribe via RSS
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </>
  )
}

function FaqAccordionItem({ question, answer }: { question: string; answer: string }) {
  return (
    <details className="group rounded-xl border border-border bg-surface overflow-hidden">
      <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer list-none select-none hover:bg-surface-canvas transition">
        <span className="font-medium text-body text-ink-primary pr-2">{question}</span>
        <svg
          className="flex-shrink-0 w-5 h-5 text-ink-tertiary group-open:rotate-180 group-open:text-brand-accent transition-transform duration-200"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>
      <div className="px-5 pb-5 pt-3 border-t border-border-subtle text-body-sm text-ink-secondary leading-relaxed">
        {answer}
      </div>
    </details>
  )
}
