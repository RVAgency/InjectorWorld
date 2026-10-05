import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Header } from '@/components/header/Header'
import { Footer } from '@/components/footer/Footer'
import { CountPill } from '@/components/shared/CountPill'
import { FaqAccordionItem } from '@/components/shared/FaqAccordionItem'
import { FaqHashOpener } from '@/components/faq/FaqHashOpener'
import { getFaqCategoryPage, getFaqHub } from '@/lib/faqs/queries'
import { getPageRobots } from '@/lib/page-index/queries'
import { webPageRef } from '@/lib/json-ld'

/**
 * /faq/<slug>: the home of every FAQ in one category, grouped by section.
 *
 * The ONLY page that emits FAQPage schema for collection FAQs. Treatment, brand,
 * guide and place pages show a short preview and link here. No minimum count:
 * a category with one approved question still gets its page (founder decision
 * 2026-09-13). See docs/FAQ-SYSTEM-2026-09-13.md.
 */
export const revalidate = 300

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://injector.world'

export async function generateStaticParams() {
  try {
    const hub = await getFaqHub()
    return (hub?.groups ?? []).flatMap((g) => g.categories.map((c) => ({ slug: c.slug })))
  } catch {
    return []
  }
}

function describe(name: string, total: number): string {
  return `Answers to ${total} common question${total === 1 ? '' : 's'} about ${name}: what it is, what it costs, what results to expect and what can go wrong.`
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const data = await getFaqCategoryPage(slug)
  if (!data) return {}
  const { category, total } = data
  const title = category.metaTitle || `${category.name} FAQs: ${total} Question${total === 1 ? '' : 's'} Answered | injector.world`
  const description = category.metaDescription || category.intro || describe(category.name, total)
  const url = `${siteUrl}/faq/${category.slug}`
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url },
    ...(await getPageRobots(`/faq/${category.slug}`)),
  }
}

export default async function FaqCategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = await getFaqCategoryPage(slug)
  if (!data) notFound()

  const { category, sections, total, links, settings, lastUpdated } = data
  const url = `${siteUrl}/faq/${category.slug}`
  const allFaqs = sections.flatMap((s) => s.faqs)

  const schema: object[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
        { '@type': 'ListItem', position: 2, name: 'FAQ', item: `${siteUrl}/faq` },
        { '@type': 'ListItem', position: 3, name: category.name },
      ],
    },
    {
      // Added 2026-10-05 per the SEO expert's spec. Sits alongside the FAQPage
      // below, it does not replace it.
      '@context': 'https://schema.org',
      '@type': 'MedicalWebPage',
      name: `${category.name} FAQs`,
      url,
      mainEntityOfPage: webPageRef(url),
    },
  ]
  if (settings.schemaEnabled) {
    schema.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      url,
      mainEntity: allFaqs.map((f) => ({
        '@type': 'Question',
        name: f.question,
        url: `${url}#${f.anchor}`,
        acceptedAnswer: { '@type': 'Answer', text: f.detail ? `${f.answer} ${f.detail}` : f.answer },
      })),
    })
  }

  const updated = lastUpdated
    ? new Date(lastUpdated).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : null

  return (
    <>
      {schema.map((s, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(s).replace(/</g, '\\u003c') }} />
      ))}

      <Header />
      <FaqHashOpener />

      <div className="bg-surface border-b border-border">
        <div className="max-canvas py-3">
          <nav className="flex items-center gap-2 text-caption text-ink-tertiary" aria-label="Breadcrumb">
            <Link href="/" className="hover:text-ink-primary transition">Home</Link>
            <span>/</span>
            <Link href="/faq" className="hover:text-ink-primary transition">FAQ</Link>
            <span>/</span>
            <span className="text-ink-primary">{category.name}</span>
          </nav>
        </div>
      </div>

      <section className="bg-surface-warm border-b border-border pb-8 pt-8 md:pb-10 md:pt-10">
        <div className="max-canvas max-w-4xl">
          <h1 className="font-serif text-h1-m md:text-h1 font-medium leading-tight tracking-tight text-ink-primary mb-3">
            {category.name} FAQs
          </h1>
          <p className="font-serif text-lede-m md:text-lede text-ink-secondary">
            {category.intro || describe(category.name, total)}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <CountPill count={total} label={total === 1 ? 'question' : 'questions'} />
            {updated && <span className="text-caption text-ink-tertiary">Updated {updated}</span>}
          </div>
          {sections.length > 1 && (
            <nav aria-label="Sections" className="mt-6 flex flex-wrap gap-2">
              {sections.map((s) => (
                <a
                  key={s.value}
                  href={`#section-${s.value}`}
                  className="rounded-control border border-border bg-surface-canvas px-3 py-1.5 text-body-sm text-ink-secondary transition hover:border-ink-primary hover:text-ink-primary"
                >
                  {s.label} <span className="text-ink-tertiary">({s.faqs.length})</span>
                </a>
              ))}
            </nav>
          )}
        </div>
      </section>

      <div className="section-pad bg-surface-canvas">
        <div className="max-canvas max-w-4xl space-y-12">
          {sections.map((s) => (
            <section key={s.value} id={`section-${s.value}`} className="scroll-mt-28">
              <h2 className="font-serif text-h2-m md:text-h2 text-ink-primary mb-5">{s.label}</h2>
              <div className="space-y-2">
                {s.faqs.map((f) => (
                  <FaqAccordionItem
                    key={f.id}
                    id={f.anchor}
                    question={f.question}
                    answer={f.answer}
                    detail={f.detail}
                    offLabel={f.offLabel}
                    safetyFlag={f.safetyFlag}
                    relatedGuideSlug={f.relatedGuideSlug}
                    relatedGuideTitle={f.relatedGuideTitle}
                  />
                ))}
              </div>
            </section>
          ))}

          {links.length > 0 && (
            <div className="rounded-control border border-border bg-surface p-6">
              <h2 className="font-serif text-h3-m md:text-h3 text-ink-primary mb-4">Next steps</h2>
              <ul className="space-y-2">
                {links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="inline-flex items-center gap-1.5 text-body font-medium text-ink-primary underline decoration-border underline-offset-4 transition hover:decoration-ink-primary">
                      {l.label}
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-4 border-t border-border pt-6 md:flex-row md:items-center md:justify-between">
            <p className="max-w-2xl text-body-sm text-ink-tertiary">
              General information from our editorial team, not medical advice. Talk to a licensed provider about your
              own situation. See our{' '}
              <Link href="/editorial-standards" className="underline underline-offset-4 hover:text-ink-primary">
                editorial standards
              </Link>
              .
            </p>
            <Link href="/faq" className="flex-shrink-0 text-body-sm font-semibold text-ink-primary hover:underline">
              All FAQ topics
            </Link>
          </div>
        </div>
      </div>

      <Footer />
    </>
  )
}
