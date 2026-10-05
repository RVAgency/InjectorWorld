/**
 * Phase 15: JSON content importer for news articles and guides.
 *
 * Accepts the shape in data/samples/news.import-template.json (guides:
 * data/samples/guides.import-template.json).
 * Validates, resolves relations, converts body to Lexical JSON,
 * maps structured fields, upserts by slug, raises DataAlerts for issues.
 * Never throws the whole batch on one bad row.
 */

import type { Payload } from 'payload'
import type { AlertInput } from './import-data'

export type ContentImportItem = {
  status?: string
  featured?: boolean
  tier?: string
  category?: string
  subcategory?: string
  title?: string
  slug?: string
  excerpt?: string
  coverImageUrl?: string
  coverImageAlt?: string
  authorName?: string
  medicalReviewer?: {
    required?: boolean
    name?: string
    credentials?: string
    reviewedAt?: string
  }
  relatedTreatmentSlug?: string
  publishedAt?: string
  lastUpdatedAt?: string
  seo?: {
    metaTitle?: string
    metaDescription?: string
    canonicalPath?: string
    focusKeyword?: string
    secondaryKeywords?: string[]
    entities?: string[]
  }
  body?: {
    answerSnippet?: string
    introParagraphs?: string[]
    sections?: Array<{ heading?: string; paragraphs?: string[] }>
    atAGlance?: string[]
    faq?: Array<{ question?: string; answer?: string }>
    sources?: Array<{
      title?: string
      publisher?: string
      url?: string
      publishedDate?: string
      sourceType?: string
      claimsSupported?: string[]
    }>
    internalLinks?: Array<{ label?: string; path?: string }>
    disclaimer?: string
  }
  validationRules?: {
    titleRequired?: boolean
    slugMustNotStartWithSlash?: boolean
    excerptMaxCharacters?: number
    bodyTargetWordCountMin?: number
    bodyTargetWordCountMax?: number
    atAGlanceMinItems?: number
    atAGlanceMaxItems?: number
    faqMinItems?: number
    faqMaxItems?: number
    sourcesMinItems?: number
    publishAsDraftUnlessHumanReviewed?: boolean
  }
}

export type ContentImportPayload = {
  templateVersion?: string
  site?: string
  contentKind?: string
  generationDate?: string
  items?: ContentImportItem[]
}

export type ContentImportCounts = { created: number; updated: number; skipped: number }

export type ContentImportReport = {
  collection: string
  items: ContentImportCounts
  alerts: AlertInput[]
  dryRun: boolean
  batch: string
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/** Build a minimal Lexical JSON body from the template's introParagraphs + sections. */
function buildLexicalBody(
  introParagraphs: string[] = [],
  sections: Array<{ heading?: string; paragraphs?: string[] }> = [],
): object {
  const children: object[] = []

  for (const text of introParagraphs) {
    if (!text?.trim()) continue
    children.push(makeParagraph(text))
  }

  for (const section of sections) {
    if (section.heading?.trim()) {
      children.push(makeHeading(section.heading))
    }
    for (const para of section.paragraphs ?? []) {
      if (!para?.trim()) continue
      children.push(makeParagraph(para))
    }
  }

  return {
    root: {
      type: 'root',
      format: '',
      indent: 0,
      version: 1,
      children: children.length ? children : [makeParagraph('')],
    },
  }
}

function makeParagraph(text: string): object {
  return {
    type: 'paragraph',
    format: '',
    indent: 0,
    version: 1,
    children: [{ type: 'text', format: 0, mode: 'normal', style: '', text, version: 1 }],
  }
}

function makeHeading(text: string): object {
  return {
    type: 'heading',
    tag: 'h2',
    format: '',
    indent: 0,
    version: 1,
    children: [{ type: 'text', format: 0, mode: 'normal', style: '', text, version: 1 }],
  }
}

/** Count approximate words across introParagraphs + sections. */
function bodyWordCount(body: ContentImportItem['body']): number {
  let count = 0
  for (const p of body?.introParagraphs ?? []) count += wordCount(p)
  for (const s of body?.sections ?? []) {
    for (const p of s.paragraphs ?? []) count += wordCount(p)
  }
  return count
}

async function findByField(
  payload: Payload,
  collection: string,
  field: string,
  value: string,
): Promise<any> {
  const res = await payload.find({
    collection: collection as any,
    where: { [field]: { equals: value } } as any,
    limit: 1,
    depth: 0,
  })
  return res.docs[0] ?? null
}

// -----------------------------------------------------------------------------
// Main importer
// -----------------------------------------------------------------------------

// -- Category normalizers ------------------------------------------------------

const NEWS_CATEGORIES = new Set([
  'treatment-update', 'industry', 'company', 'announcement',
  'product-launch', 'research', 'regulation',
])
const GUIDES_CATEGORIES = new Set([
  'treatment-guide', 'article', 'expert-qa', 'cost-report',
])

const NEWS_CATEGORY_MAP: Record<string, string> = {
  'regulatory': 'regulation', 'regulatory-update': 'regulation', 'regulatory update': 'regulation',
  'treatment update': 'treatment-update', 'treatment_update': 'treatment-update',
  'product': 'product-launch', 'product launch': 'product-launch', 'product_launch': 'product-launch',
  'science': 'research', 'science and research': 'research',
}
const GUIDES_CATEGORY_MAP: Record<string, string> = {
  'guide': 'treatment-guide', 'treatment guide': 'treatment-guide', 'treatment_guide': 'treatment-guide',
  'cost': 'cost-report', 'cost report': 'cost-report', 'cost_report': 'cost-report',
  'expert q&a': 'expert-qa', 'expert qa': 'expert-qa', 'expert_qa': 'expert-qa', 'qa': 'expert-qa',
}

function normalizeCategory(raw: string | undefined, collectionSlug: string): string {
  const defaultVal = collectionSlug === 'guides' ? 'treatment-guide' : 'industry'
  if (!raw) return defaultVal
  const lower = raw.trim().toLowerCase()
  if (collectionSlug === 'guides') {
    if (GUIDES_CATEGORIES.has(lower)) return lower
    return GUIDES_CATEGORY_MAP[lower] ?? defaultVal
  }
  if (NEWS_CATEGORIES.has(lower)) return lower
  return NEWS_CATEGORY_MAP[lower] ?? defaultVal
}

// -----------------------------------------------------------------------------

export async function runContentImport(
  payload: Payload,
  parsed: ContentImportPayload,
  opts: { dryRun?: boolean; batch?: string } = {},
): Promise<ContentImportReport> {
  const dryRun = opts.dryRun !== false // default true
  const batch = opts.batch || `content-import-${new Date().toISOString().slice(0, 19)}`
  const collectionSlug = (parsed.contentKind === 'guide' || parsed.contentKind === 'guides') ? 'guides' : 'news'
  // alerts = pending (flushed + cleared per item in commit mode)
  // reportAlerts = full list returned to the caller (never cleared)
  const alerts: AlertInput[] = []
  const reportAlerts: AlertInput[] = []
  const counts: ContentImportCounts = { created: 0, updated: 0, skipped: 0 }

  // Preload treatments lookup (slug -> id)
  const treatmentsRes = await payload.find({ collection: 'services', limit: 1000, depth: 0 })
  const treatmentBySlug: Record<string, number> = {}
  for (const t of treatmentsRes.docs) {
    treatmentBySlug[t.slug as string] = t.id as number
  }

  // Validate we have items
  const items = parsed.items ?? []
  if (items.length === 0) {
    alerts.push({
      alertKey: `content-import-empty-${batch}`,
      type: 'content_validation_error',
      severity: 'warning',
      message: 'Import file contained no items.',
      collectionSlug,
    })
    return { collection: collectionSlug, items: counts, alerts, dryRun, batch }
  }

  // Seen slugs within this batch to detect intra-batch duplicates
  const seenSlugs = new Set<string>()

  for (const item of items) {
    const slug = item.slug?.trim()
    const title = item.title?.trim()

    // Title required
    if (!title) {
      alerts.push({
        alertKey: `content-no-title-${batch}-${slug ?? 'no-slug'}`,
        type: 'content_validation_error',
        severity: 'error',
        message: `Item skipped: missing title (slug: "${slug ?? 'unknown'}").`,
        collectionSlug,
      })
      counts.skipped++
      continue
    }

    // Slug required and must not start with /
    if (!slug) {
      alerts.push({
        alertKey: `content-no-slug-${batch}-${title.slice(0, 40)}`,
        type: 'content_validation_error',
        severity: 'error',
        message: `Item skipped: missing slug (title: "${title}").`,
        collectionSlug,
      })
      counts.skipped++
      continue
    }
    if (slug.startsWith('/')) {
      alerts.push({
        alertKey: `content-slug-slash-${batch}-${slug}`,
        type: 'content_validation_error',
        severity: 'error',
        message: `Item skipped: slug must not start with "/" - got "${slug}".`,
        collectionSlug,
        documentId: slug,
      })
      counts.skipped++
      continue
    }

    // Intra-batch duplicate slug
    if (seenSlugs.has(slug)) {
      alerts.push({
        alertKey: `content-dup-slug-${batch}-${slug}`,
        type: 'content_duplicate_slug',
        severity: 'warning',
        message: `Duplicate slug within batch "${batch}": "${slug}". Second occurrence skipped.`,
        collectionSlug,
        documentId: slug,
      })
      counts.skipped++
      continue
    }
    seenSlugs.add(slug)

    // Excerpt length check
    const rules = item.validationRules ?? {}
    const maxExcerpt = rules.excerptMaxCharacters ?? 300
    if (item.excerpt && item.excerpt.length > maxExcerpt) {
      alerts.push({
        alertKey: `content-excerpt-long-${batch}-${slug}`,
        type: 'content_validation_error',
        severity: 'warning',
        message: `Article "${slug}": excerpt is ${item.excerpt.length} chars (max ${maxExcerpt}).`,
        collectionSlug,
        documentId: slug,
      })
    }

    // Body word count
    const wc = bodyWordCount(item.body)
    const minWc = rules.bodyTargetWordCountMin ?? 150
    const maxWc = rules.bodyTargetWordCountMax ?? 1500
    if (wc < minWc) {
      alerts.push({
        alertKey: `content-wc-low-${batch}-${slug}`,
        type: 'content_validation_error',
        severity: 'warning',
        message: `Article "${slug}": body is ~${wc} words (min ${minWc}).`,
        collectionSlug,
        documentId: slug,
      })
    } else if (wc > maxWc) {
      alerts.push({
        alertKey: `content-wc-high-${batch}-${slug}`,
        type: 'content_validation_error',
        severity: 'warning',
        message: `Article "${slug}": body is ~${wc} words (max ${maxWc}).`,
        collectionSlug,
        documentId: slug,
      })
    }

    // atAGlance count
    const glanceItems = item.body?.atAGlance ?? []
    const minGlance = rules.atAGlanceMinItems ?? 4
    if (glanceItems.length < minGlance) {
      alerts.push({
        alertKey: `content-glance-low-${batch}-${slug}`,
        type: 'content_validation_error',
        severity: 'warning',
        message: `Article "${slug}": atAGlance has ${glanceItems.length} items (min ${minGlance}).`,
        collectionSlug,
        documentId: slug,
      })
    }

    // FAQ count
    const faqItems = item.body?.faq ?? []
    const minFaq = rules.faqMinItems ?? 2
    if (faqItems.length < minFaq) {
      alerts.push({
        alertKey: `content-faq-low-${batch}-${slug}`,
        type: 'content_validation_error',
        severity: 'warning',
        message: `Article "${slug}": faq has ${faqItems.length} items (min ${minFaq}).`,
        collectionSlug,
        documentId: slug,
      })
    }

    // Sources count
    const sourceItems = item.body?.sources ?? []
    const minSources = rules.sourcesMinItems ?? 3
    if (sourceItems.length < minSources) {
      alerts.push({
        alertKey: `content-sources-low-${batch}-${slug}`,
        type: 'content_few_sources',
        severity: 'warning',
        message: `Article "${slug}": sources has ${sourceItems.length} items (min ${minSources}).`,
        collectionSlug,
        documentId: slug,
      })
    }

    // Cover image
    if (!item.coverImageUrl) {
      alerts.push({
        alertKey: `content-no-cover-${batch}-${slug}`,
        type: 'content_missing_cover',
        severity: 'info',
        message: `Article "${slug}" has no cover image URL.`,
        collectionSlug,
        documentId: slug,
      })
    }

    // Resolve author (skip + DataAlert if not found)
    let authorId: number | null = null
    if (item.authorName?.trim()) {
      const author = await findByField(payload, 'authors', 'fullName', item.authorName.trim())
      if (author) {
        authorId = author.id as number
      } else {
        alerts.push({
          alertKey: `content-missing-author-${batch}-${slug}`,
          type: 'content_missing_author',
          severity: 'warning',
          message: `Author "${item.authorName}" not found in Authors collection for article "${slug}". Relation left unlinked.`,
          collectionSlug,
          documentId: slug,
        })
      }
    } else {
      alerts.push({
        alertKey: `content-no-author-${batch}-${slug}`,
        type: 'content_missing_author',
        severity: 'warning',
        message: `No authorName provided for article "${slug}". Relation left unlinked.`,
        collectionSlug,
        documentId: slug,
      })
    }

    // author is required on both collections - fall back to editorial team stub, auto-creating it if needed
    if (!authorId) {
      let editorial = await findByField(payload, 'authors', 'fullName', 'injector.world Editorial Team')
        ?? await findByField(payload, 'authors', 'fullName', 'injector.world Editorial')

      if (!editorial && !dryRun) {
        // Auto-create the editorial team stub so imports don't require manual setup
        try {
          editorial = await payload.create({
            collection: 'authors',
            data: {
              fullName: 'injector.world Editorial Team',
              slug: 'injectors-world-editorial-team',
              role: 'Editorial Team',
              bio: 'The injector.world editorial team.',
            },
            overrideAccess: true,
          })
          alerts.push({
            alertKey: `content-editorial-stub-created-${batch}`,
            type: 'content_missing_author',
            severity: 'info',
            message: 'Auto-created "injector.world Editorial Team" author stub for bulk import.',
            collectionSlug,
          })
        } catch {
          // creation failed - will skip below
        }
      }

      if (editorial) {
        authorId = editorial.id as number
      }
    }

    if (!authorId && !dryRun) {
      // Commit mode: could not resolve or auto-create an author - hard skip
      alerts.push({
        alertKey: `content-no-author-fatal-${batch}-${slug}`,
        type: 'content_missing_author',
        severity: 'error',
        message: `Article "${slug}" skipped: could not resolve or create an author.`,
        collectionSlug,
        documentId: slug,
      })
      counts.skipped++
      continue
    }
    // In dry run with no authorId: push an info note and fall through to the dry-run count below.
    if (!authorId && dryRun) {
      alerts.push({
        alertKey: `content-no-author-dryrun-${batch}-${slug}`,
        type: 'content_missing_author',
        severity: 'info',
        message: `Article "${slug}": no author found. An "injector.world Editorial Team" stub will be auto-created on Commit.`,
        collectionSlug,
        documentId: slug,
      })
    }

    // Resolve medical reviewer (skip + DataAlert)
    let medicalReviewerId: number | null = null
    const reviewerName = item.medicalReviewer?.name?.trim()
    if (reviewerName) {
      const reviewer = await findByField(payload, 'medical-reviewers', 'fullName', reviewerName)
      if (reviewer) {
        medicalReviewerId = reviewer.id as number
      } else {
        alerts.push({
          alertKey: `content-missing-reviewer-${batch}-${slug}`,
          type: 'content_missing_reviewer',
          severity: 'warning',
          message: `Medical reviewer "${reviewerName}" not found for article "${slug}". Relation left unlinked.`,
          collectionSlug,
          documentId: slug,
        })
      }
    } else if (item.medicalReviewer?.required) {
      alerts.push({
        alertKey: `content-no-reviewer-${batch}-${slug}`,
        type: 'content_missing_reviewer',
        severity: 'warning',
        message: `No medical reviewer provided for article "${slug}" (marked required in template).`,
        collectionSlug,
        documentId: slug,
      })
    }

    // Resolve treatment
    let relatedTreatmentId: number | null = null
    if (item.relatedTreatmentSlug?.trim()) {
      relatedTreatmentId = treatmentBySlug[item.relatedTreatmentSlug.trim()] ?? null
      if (!relatedTreatmentId) {
        alerts.push({
          alertKey: `content-unknown-treatment-${batch}-${slug}`,
          type: 'content_validation_error',
          severity: 'info',
          message: `Treatment slug "${item.relatedTreatmentSlug}" not found for article "${slug}".`,
          collectionSlug,
          documentId: slug,
        })
      }
    }

    // Build Lexical body
    const lexicalBody = buildLexicalBody(
      item.body?.introParagraphs ?? [],
      item.body?.sections ?? [],
    )

    // Build structured fields
    const answerSnippet = item.body?.answerSnippet?.trim() || null
    const atAGlance = glanceItems.length > 0 ? glanceItems : null
    const faqData =
      faqItems.length > 0
        ? faqItems.map((f) => ({ question: f.question ?? '', answer: f.answer ?? '' }))
        : null
    const sourcesData =
      sourceItems.length > 0
        ? sourceItems.map((s) => ({
            title: s.title ?? '',
            publisher: s.publisher ?? '',
            url: s.url ?? '',
            publishedDate: s.publishedDate ?? '',
            sourceType: s.sourceType ?? 'news',
            claimsSupported: s.claimsSupported ?? [],
          }))
        : null

    // Map category - normalise AI variations to exact select values
    const category = normalizeCategory(item.category, collectionSlug)

    // Check if slug already exists (for upsert)
    const existing = await findByField(payload, collectionSlug, 'slug', slug)

    if (dryRun) {
      existing ? counts.updated++ : counts.created++
      continue
    }

    // Build document data
    const excerptRaw = item.excerpt?.trim() ?? ''
    // News: required, max 300. Guides: not required, max 200.
    const excerptValue = collectionSlug === 'guides'
      ? (excerptRaw ? excerptRaw.slice(0, 198) : undefined)
      : (excerptRaw.slice(0, 298) || title.slice(0, 298))
    const docBase: Record<string, any> = {
      title,
      slug,
      ...(excerptValue !== undefined ? { excerpt: excerptValue } : {}),
      coverImageUrl: item.coverImageUrl ?? null,
      body: lexicalBody,
      category,
      author: authorId,
      ...(medicalReviewerId ? { medicalReviewer: medicalReviewerId } : {}),
      ...(relatedTreatmentId ? { relatedTreatment: relatedTreatmentId } : {}),
      publishedAt: item.publishedAt ?? null,
      // Structured body
      ...(answerSnippet ? { answerSnippet } : {}),
      ...(atAGlance ? { atAGlance } : {}),
      ...(faqData ? { faq: faqData } : {}),
      ...(sourcesData ? { sources: sourcesData } : {}),
      // Meta (seoPlugin fields - stored in the meta group)
      meta: {
        title: item.seo?.metaTitle ?? title,
        description: item.seo?.metaDescription ?? item.excerpt ?? '',
      },
      // Visibility defaults for new imports
      reviewStatus: 'imported' as const,
      indexState: 'noindex' as const,
      nofollow: true,
      status: 'draft' as const,
      featured: item.featured ?? false,
      importBatch: batch,
    }

    // Guides-specific
    if (collectionSlug === 'guides') {
      docBase.lede = item.excerpt?.trim() || title
      docBase.sourcesCount = sourcesData?.length ?? 0
      if (item.medicalReviewer?.reviewedAt) {
        docBase.lastMedicallyReviewed = item.medicalReviewer.reviewedAt
      }
    }

    try {
      if (existing) {
        // Upsert: update but PRESERVE reviewStatus/indexState/nofollow if already approved
        const preserveApproved = existing.reviewStatus === 'approved'
        await payload.update({
          collection: collectionSlug as any,
          id: existing.id,
          data: {
            ...docBase,
            // Do not downgrade an already-approved item
            ...(preserveApproved
              ? {
                  reviewStatus: 'approved' as const,
                  indexState: existing.indexState,
                  nofollow: existing.nofollow,
                  status: 'published' as const,
                }
              : {}),
          },
          overrideAccess: true,
        })
        counts.updated++
      } else {
        await payload.create({
          collection: collectionSlug as any,
          data: docBase,
          overrideAccess: true,
        })
        counts.created++
      }

      // Persist alerts to DataAlerts collection, then clear the pending buffer.
      // reportAlerts keeps a copy of everything for the HTTP response.
      reportAlerts.push(...alerts)
      await upsertAlerts(payload, alerts)
      alerts.length = 0
    } catch (err: any) {
      alerts.push({
        alertKey: `content-create-fail-${batch}-${slug}`,
        type: 'content_validation_error',
        severity: 'error',
        message: `Failed to save article "${slug}": ${err?.message ?? 'unknown error'}`,
        collectionSlug,
        documentId: slug,
      })
      counts.skipped++
    }
  }

  // Flush any remaining alerts (from skipped items / final item errors)
  if (!dryRun && alerts.length > 0) {
    reportAlerts.push(...alerts)
    await upsertAlerts(payload, alerts)
  }

  // In dry run, alerts was never cleared - return it directly.
  // In commit mode, return reportAlerts which accumulated everything.
  return { collection: collectionSlug, items: counts, alerts: dryRun ? alerts : reportAlerts, dryRun, batch }
}

/** Upsert DataAlerts - mirrors the pattern in lib/import/import-data.ts */
async function upsertAlerts(payload: Payload, alerts: AlertInput[]) {
  for (const a of alerts) {
    try {
      const existing = await payload.find({
        collection: 'data-alerts',
        where: { alertKey: { equals: a.alertKey } },
        limit: 1,
        depth: 0,
      })
      if (existing.docs[0]) {
        await payload.update({
          collection: 'data-alerts',
          id: existing.docs[0].id,
          data: { message: a.message, severity: a.severity, status: 'open' },
          overrideAccess: true,
        })
      } else {
        await payload.create({
          collection: 'data-alerts',
          data: { ...a, status: 'open', source: 'content-import' } as any,
          overrideAccess: true,
        })
      }
    } catch {
      // Non-fatal: alert upsert failure does not block the import
    }
  }
}

