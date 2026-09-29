/**
 * What each admin export contains, and how its rows are fetched.
 *
 * Every collection here is exported the same way: `countSql` gives the progress
 * denominator, then `pageSql` is called repeatedly with a keyset cursor until it
 * returns nothing. Keyset (`id > $lastId ORDER BY id`) rather than OFFSET, because
 * OFFSET degrades badly by the 37,000th clinic row.
 *
 * `hydrate` exists for the clinics export only: services and brands live in
 * `clinics_rels`, and pulling them with a correlated subquery per row would be
 * ~37,000 extra round trips. Instead each batch does ONE grouped query per
 * relation and joins in memory. Same lesson as the clinics import pipeline.
 */

import { lookupSlugs, type LocationSlugEntry } from '../location-slug-lookup'

export type ExportFilters = {
  state?: string
  city?: string
  brandSlug?: string
  serviceSlug?: string
}

export type ExportColumn = { header: string; key: string; width?: number }

/**
 * Per-job context handed to `hydrate`. `slugMap` is only populated for
 * definitions that set `needsLocationSlugs`, and it is fetched ONCE per job
 * rather than per batch: getLocationSlugMap() memoises for 60s, and a 37,000-row
 * export runs well past that, so a per-batch call would silently re-query all
 * ~5,000 locations several times mid-export.
 */
export type ExportContext = {
  siteUrl: string
  slugMap?: Map<string, LocationSlugEntry>
}

export type ExportDefinition = {
  label: string
  /** Sheet name inside the workbook. */
  sheet: string
  columns: ExportColumn[]
  /** Whether state/city/brand/service filters apply to this collection at all. */
  supportsFilters: boolean
  /** Ask the runner to load the location slug map before hydrating. */
  needsLocationSlugs?: boolean
  buildCount: (f: ExportFilters) => { text: string; values: unknown[] }
  buildPage: (f: ExportFilters, lastId: number, limit: number) => { text: string; values: unknown[] }
  hydrate?: (pool: any, rows: any[], ctx: ExportContext) => Promise<void>
  mapRow: (row: any, siteUrl: string) => Record<string, unknown>
}

/**
 * Filters only ever apply to clinics. Guides/News/FAQs/Brands/Services have no
 * state or city, so their definitions set supportsFilters:false and the API
 * rejects filters on them rather than silently ignoring them.
 */
function clinicWhere(f: ExportFilters, values: unknown[]): string {
  const parts = [`c.status = 'published'`]
  if (f.state) {
    values.push(f.state)
    parts.push(`c.state = $${values.length}`)
  }
  if (f.city) {
    values.push(f.city)
    parts.push(`LOWER(c.city) = LOWER($${values.length})`)
  }
  if (f.brandSlug) {
    values.push(f.brandSlug)
    parts.push(`EXISTS (SELECT 1 FROM clinics_rels r JOIN brands b ON b.id = r.brands_id
                        WHERE r.parent_id = c.id AND r.path = 'brandsOffered' AND b.slug = $${values.length})`)
  }
  if (f.serviceSlug) {
    values.push(f.serviceSlug)
    parts.push(`EXISTS (SELECT 1 FROM clinics_rels r JOIN services s ON s.id = r.services_id
                        WHERE r.parent_id = c.id AND r.path = 'servicesOffered' AND s.slug = $${values.length})`)
  }
  return parts.join(' AND ')
}

// email_public, linkedin_url, youtube_url are declared in collections/Clinics.ts and
// DO exist on staging's `clinics` table (confirmed 2026-08-12 via information_schema on
// the staging cluster) -- but do NOT exist yet on production's, which never got the
// db:push for these fields. This export is built and verified against staging, where
// they're present. If this code ships to production (`git push origin main`) before
// production's schema catches up, these three columns will 500 the export there until
// `npm run db:push` is run against production too.
const CLINIC_SELECT = `
  c.id, c.clinic_id, c.slug, c.updated_at, c.clinic_name, c.clinic_type,
  c.phone, c.email, c.booking_url, c.website_url,
  c.address_line1, c.city, c.state, c.zip,
  c.google_maps_url, c.google_place_id,
  c.aggregate_rating, c.aggregate_rating_count,
  c.facebook_url, c.instagram_url, c.tiktok_url,
  u.email AS owner_email,
  c.tagline, c.description,
  c.accepts_insurance, c.payment_methods, c.amenities,
  c.address_line2, c.neighborhood, c.county, c.country,
  c.latitude, c.longitude, c.directions_url, c.apple_maps_url,
  c.hours_json, c.starting_price,
  c.logo_url, c.subscription_tier, c.subscription_status, c.claimed,
  c.import_batch, c.last_scraped_date,
  c.email_public, c.linkedin_url, c.youtube_url,
  c.status, c.noindex, c.published_at, c.data_confidence, c.needs_manual_review,
  c.created_at
`

// ─── Guides & News: full content audit (2026-09-28) ─────────────────────────
//
// Was four columns (title, url, category, published) over approved rows only.
// The IW client team asked for everything the admin's Content indexing panel
// shows per article, with the character length of every text value next to it
// ("Title Length (chars)", "URL Length (chars)", ...). One definition serves
// both collections so the two sheets can never drift apart.
//
// Every row, not only approved ones: like the FAQs export, this is an audit
// list, and "Review Status" / "Live on Site" say which rows are public.

/** Admin wording for page_index.index_mode, same as the Indexing screens. */
const INDEX_LABEL: Record<string, string> = {
  queued: 'Not submitted',
  indexed: 'Submitted to Google',
  excluded: 'Never submit',
}

/** Plain text of a Lexical rich-text document, for the word and character counts. */
function lexicalPlainText(node: any): string {
  if (!node || typeof node !== 'object') return ''
  if (typeof node.text === 'string') return node.text
  const kids = Array.isArray(node.children) ? node.children : node.root ? [node.root] : []
  return kids
    .map(lexicalPlainText)
    .join(node.type === 'root' || node.type === 'list' ? '\n' : node.children ? ' ' : '')
}

const ymd = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : '')
const yesNo = (b: unknown) => (b ? 'Yes' : 'No')
const jsonCount = (v: unknown) => (Array.isArray(v) ? v.length : 0)

/**
 * Columns the founder took out of each sheet by hand after the first version
 * (2026-09-28) and asked to leave out of the export as well. The two lists
 * differ on purpose: they mirror the approved sheets exactly.
 */
const CONTENT_EXPORT_OMIT: Record<'guides' | 'news', Set<string>> = {
  guides: new Set([
    'Author Length (chars)',
    'Medical Reviewer',
    'Medical Reviewer Length (chars)',
    'Related Service',
    'Related Service Length (chars)',
    'Import Batch',
  ]),
  news: new Set([
    'Internal Links Count',
    'Schema',
    'In Sitemap',
    'Index Batch',
    'Submitted to Google On',
    'Import Batch',
    'Import Batch Length (chars)',
    'Admin Edit Link',
  ]),
}

function contentExport(table: 'guides' | 'news'): ExportDefinition {
  const isGuide = table === 'guides'
  const omit = CONTENT_EXPORT_OMIT[table]
  const columns: ExportColumn[] = []
  // Text columns listed here get a "<header> Length (chars)" column right after them.
  const lengthKeys: string[] = []
  const add = (header: string, key: string, width: number, withLength = false) => {
    if (!omit.has(header)) columns.push({ header, key, width })
    const lengthHeader = `${header} Length (chars)`
    if (withLength && !omit.has(lengthHeader)) {
      columns.push({ header: lengthHeader, key: `${key}Len`, width: 12 })
      lengthKeys.push(key)
    }
  }
  add('ID', 'id', 7)
  add('Title', 'title', 50, true)
  add('URL', 'url', 60, true)
  add('Slug', 'slug', 40, true)
  add('Category', 'category', 18, true)
  add('Status', 'status', 11)
  add('Review Status', 'reviewStatus', 13)
  add('Live on Site', 'live', 10)
  add('Hero Image on Page', 'hero', 11)
  add('Hero Image Source', 'heroSource', 16)
  add('Hero Image URL', 'heroUrl', 60, true)
  add('Hero Image Alt Text', 'heroAlt', 30, true)
  add('Share (OG) Image Set', 'ogImage', 12)
  add('Meta Title (as used on page)', 'metaTitle', 50, true)
  add('Meta Title Stored', 'metaTitleStored', 10)
  add('Meta Description', 'metaDescription', 60, true)
  add('Excerpt', 'excerpt', 50, true)
  if (isGuide) add('Lede (hero subhead)', 'lede', 50, true)
  add('Answer Snippet', 'answerSnippet', 50, true)
  add('Focus Keyword', 'focusKeyword', 22, true)
  add('Author', 'author', 22, true)
  add('Medical Reviewer', 'reviewer', 26, true)
  add('Related Service', 'relatedService', 22, true)
  add('Body Word Count', 'bodyWords', 11)
  add('Body Character Count', 'bodyChars', 11)
  if (isGuide) add('Read Time (min)', 'readTime', 10)
  add('FAQ Count', 'faqCount', 9)
  add('Sources Count', 'sourcesCount', 9)
  add('Internal Links Count', 'linksCount', 10)
  add('Schema', 'schema', 34)
  add('Google Index Status', 'indexStatus', 18)
  add('Robots Tag Now', 'robots', 16)
  add('In Sitemap', 'inSitemap', 10)
  add('Index Batch', 'batch', 22)
  add('Submitted to Google On', 'submittedOn', 14)
  add('Uploaded', 'uploaded', 12)
  add('Published', 'published', 12)
  if (isGuide) add('Updated (shown on page)', 'contentUpdated', 13)
  add('Hero Image Updated', 'heroUpdated', 13)
  add('Last Edited in Admin', 'edited', 13)
  add('Featured', 'featured', 9)
  add('Nofollow', 'nofollow', 9)
  add('Import Batch', 'importBatch', 26, true)
  add('Admin Edit Link', 'adminUrl', 60)

  // `table` is one of two literals above, never user input, so interpolating it
  // (and the page_index source_collection, which is the same name) is safe.
  const guideOnly = isGuide
    ? 'c.lede, c.read_time_min, c.sources_count, c.content_updated_at'
    : 'NULL::text AS lede, NULL::numeric AS read_time_min, NULL::numeric AS sources_count, NULL::timestamptz AS content_updated_at'

  return {
    label: isGuide ? 'Guides' : 'News',
    sheet: isGuide ? 'Guides' : 'News',
    supportsFilters: false,
    columns,
    buildCount: () => ({ text: `SELECT COUNT(*)::int AS n FROM ${table}`, values: [] }),
    buildPage: (_f, lastId, limit) => ({
      text: `SELECT c.id, c.title, c.slug, c.category::text AS category, c.status::text AS status,
                    c.review_status::text AS review_status, c.excerpt, c.answer_snippet, c.focus_keyword,
                    c.meta_title, c.meta_description, c.meta_image_id, c.cover_image_url, c.featured,
                    c.nofollow, c.import_batch, c.created_at, c.published_at, c.updated_at,
                    c.body, c.faq, c.sources, c.internal_links, ${guideOnly},
                    m.url AS cover_upload_url, m.alt AS cover_alt, m.created_at AS cover_uploaded_at,
                    a.full_name AS author, r.full_name AS reviewer, r.credentials::text AS reviewer_credentials,
                    s.name AS related_service,
                    pi.path, pi.index_mode::text AS index_mode, COALESCE(pi.indexed, false) AS indexed,
                    COALESCE(pi.publishable, false) AS publishable, pi.indexed_at, pi.batch_label
             FROM ${table} c
             LEFT JOIN media m ON m.id = c.cover_image_id
             LEFT JOIN authors a ON a.id = c.author_id
             LEFT JOIN medical_reviewers r ON r.id = c.medical_reviewer_id
             LEFT JOIN services s ON s.id = c.related_service_id
             LEFT JOIN page_index pi ON pi.source_collection = '${table}' AND pi.source_id = c.id::text
             WHERE c.id > $1 ORDER BY c.id LIMIT $2`,
      values: [lastId, limit],
    }),
    mapRow: (r, siteUrl) => {
      // Same rule the guide and news pages use for their hero: the uploaded
      // image first, then the url field (lib/guide-queries.ts, news-queries.ts).
      const heroUrl = r.cover_upload_url || r.cover_image_url || ''
      const body = lexicalPlainText(r.body).replace(/\s+/g, ' ').trim()
      const row: Record<string, unknown> = {
        id: r.id,
        title: r.title ?? '',
        url: `${siteUrl}${r.path || `/${table}/${r.slug}`}`,
        slug: r.slug ?? '',
        category: r.category ?? '',
        status: r.status ?? '',
        reviewStatus: r.review_status ?? '',
        live: yesNo(r.publishable),
        hero: yesNo(heroUrl),
        heroSource: r.cover_upload_url ? 'Uploaded image' : r.cover_image_url ? 'Image URL field' : 'None',
        heroUrl,
        heroAlt: r.cover_alt ?? '',
        ogImage: yesNo(r.meta_image_id || heroUrl),
        // The page falls back to the title when no meta title is stored, and
        // the Content indexing panel shows the same (lib/content-index/queries.ts).
        metaTitle: r.meta_title || r.title || '',
        metaTitleStored: yesNo(r.meta_title),
        metaDescription: r.meta_description ?? '',
        excerpt: r.excerpt ?? '',
        lede: r.lede ?? '',
        answerSnippet: r.answer_snippet ?? '',
        focusKeyword: r.focus_keyword ?? '',
        author: r.author ?? '',
        reviewer: r.reviewer ? `${r.reviewer}${r.reviewer_credentials ? `, ${r.reviewer_credentials}` : ''}` : '',
        relatedService: r.related_service ?? '',
        bodyWords: body ? body.split(' ').length : 0,
        bodyChars: body.length,
        readTime: r.read_time_min != null ? Number(r.read_time_min) : '',
        faqCount: jsonCount(r.faq),
        sourcesCount: jsonCount(r.sources) || Number(r.sources_count) || 0,
        linksCount: jsonCount(r.internal_links),
        schema: isGuide ? 'MedicalWebPage + Article + FAQPage' : 'Article',
        indexStatus: r.index_mode
          ? r.indexed ? 'Submitted to Google' : INDEX_LABEL[r.index_mode] ?? r.index_mode
          : 'No url built',
        // Matches getEntityRobots(): only indexed rows are indexable.
        robots: r.indexed ? 'index, follow' : 'noindex, follow',
        inSitemap: yesNo(r.indexed),
        batch: r.batch_label ?? '',
        submittedOn: ymd(r.indexed_at),
        uploaded: ymd(r.created_at),
        published: ymd(r.published_at),
        contentUpdated: ymd(r.content_updated_at),
        // Guides and news keep no version history, so the upload date of the
        // media doc now attached is the only real record of when the hero
        // changed (2026-09-29). Blank for a hero from the url field.
        heroUpdated: r.cover_upload_url ? ymd(r.cover_uploaded_at) : '',
        edited: ymd(r.updated_at),
        featured: yesNo(r.featured),
        nofollow: yesNo(r.nofollow),
        importBatch: r.import_batch ?? '',
        adminUrl: `${siteUrl}/admin/collections/${table}/${r.id}`,
      }
      for (const k of lengthKeys) row[`${k}Len`] = String(row[k] ?? '').length
      return row
    },
  }
}

export const EXPORT_DEFINITIONS: Record<string, ExportDefinition> = {
  clinics: {
    label: 'Clinics',
    sheet: 'Clinics',
    supportsFilters: true,
    needsLocationSlugs: true,
    // Columns A..AE are Santosh's template verbatim
    // ("iw clinicdata export excel file template.xlsx", 31 columns). Seven of them
    // (Date Google Review Updated, X url, Owner Mobile/LI/FB/IH/TK) have no source
    // field in the DB and are exported empty on purpose, so the file still lines up
    // 1:1 with the template he is working against. YT Url/LI url used to be in that
    // empty group too, but now map to the clinic's own youtube_url/linkedin_url
    // columns (staging schema, see CLINIC_SELECT comment above).
    // IW-Clinic-URL is APPENDED as column AF rather than inserted, deliberately:
    // the template has no column for the clinic's page on our own site, and
    // inserting mid-sheet would shift every later column out from under whatever
    // he already has built against A..AE.
    columns: [
      { header: 'IW-Clinic-ID', key: 'iwClinicId', width: 26 },
      { header: 'Last Update Date', key: 'lastUpdate', width: 18 },
      { header: 'Clinic Name', key: 'name', width: 34 },
      { header: 'Clinic Type', key: 'type', width: 18 },
      { header: 'Treatments/Services', key: 'services', width: 50 },
      { header: 'Brands', key: 'brands', width: 40 },
      { header: 'Business Phone #', key: 'phone', width: 18 },
      { header: 'Business Email', key: 'email', width: 28 },
      { header: 'Book Consult url', key: 'bookingUrl', width: 40 },
      { header: 'Website url', key: 'websiteUrl', width: 40 },
      { header: 'Street Address', key: 'street', width: 34 },
      { header: 'City', key: 'city', width: 20 },
      { header: 'State', key: 'state', width: 8 },
      { header: 'Zipcode', key: 'zip', width: 10 },
      { header: 'GBP Profile Link', key: 'gbpLink', width: 44 },
      { header: 'Google Review Count', key: 'reviewCount', width: 18 },
      { header: 'Google Review Rating', key: 'reviewRating', width: 18 },
      { header: 'Date Google Review Updated', key: 'reviewUpdated', width: 22 }, // no source field
      { header: '# of Pics', key: 'picCount', width: 10 },
      { header: 'YT Url', key: 'ytUrl', width: 30 },
      { header: 'LI url', key: 'liUrl', width: 30 },
      { header: 'FB url', key: 'fbUrl', width: 30 },
      { header: 'IG url', key: 'igUrl', width: 30 },
      { header: 'TT url', key: 'ttUrl', width: 30 },
      { header: 'X url', key: 'xUrl', width: 30 }, // no source field
      { header: 'Owner Email', key: 'ownerEmail', width: 28 },
      { header: 'Owner Mobile', key: 'ownerMobile', width: 18 }, // no source field
      { header: 'Owner LI', key: 'ownerLi', width: 24 }, // no source field
      { header: 'Owner FB', key: 'ownerFb', width: 24 }, // no source field
      { header: 'Owner IH', key: 'ownerIh', width: 24 }, // no source field
      { header: 'Owner TK', key: 'ownerTk', width: 24 }, // no source field
      { header: 'IW-Clinic-URL', key: 'iwClinicUrl', width: 60 },
      // Everything below is appended past Santosh's template (A..AF), never inserted,
      // so his existing column references never shift. Every DB field on Clinics that
      // isn't already covered above, in the same order as the admin panel's tabs.
      { header: 'Slug', key: 'slug', width: 30 },
      { header: 'Tagline', key: 'tagline', width: 40 },
      { header: 'Description', key: 'description', width: 60 },
      { header: 'Accepts Insurance', key: 'acceptsInsurance', width: 16 },
      { header: 'Payment Methods', key: 'paymentMethods', width: 30 },
      { header: 'Amenities', key: 'amenities', width: 30 },
      { header: 'Email Public', key: 'emailPublic', width: 14 },
      { header: 'Address Line 2', key: 'addressLine2', width: 24 },
      { header: 'Neighborhood', key: 'neighborhood', width: 22 },
      { header: 'County', key: 'county', width: 18 },
      { header: 'Country', key: 'country', width: 10 },
      { header: 'Latitude', key: 'latitude', width: 14 },
      { header: 'Longitude', key: 'longitude', width: 14 },
      { header: 'Google Place ID', key: 'googlePlaceId', width: 30 },
      { header: 'Directions URL', key: 'directionsUrl', width: 40 },
      { header: 'Apple Maps URL', key: 'appleMapsUrl', width: 40 },
      { header: 'Hours (JSON)', key: 'hoursJson', width: 40 },
      { header: 'Starting Price', key: 'startingPrice', width: 16 },
      { header: 'Logo URL', key: 'logoUrl', width: 40 },
      { header: 'All Photo URLs (legacy scraped)', key: 'allPhotoUrls', width: 60 },
      { header: 'Uploaded Media Photo URLs', key: 'mediaPhotoUrls', width: 60 },
      { header: 'Subscription Tier', key: 'subscriptionTier', width: 16 },
      { header: 'Subscription Status', key: 'subscriptionStatus', width: 16 },
      { header: 'Claimed', key: 'claimed', width: 10 },
      { header: 'Import Batch', key: 'importBatch', width: 20 },
      { header: 'Last Scraped Date', key: 'lastScrapedDate', width: 18 },
      { header: 'Source URLs', key: 'sourceUrls', width: 60 },
      { header: 'Publish Status', key: 'status', width: 14 },
      { header: 'Noindex (Build Skip)', key: 'noindex', width: 16 },
      { header: 'Published At', key: 'publishedAt', width: 18 },
      { header: 'Data Confidence', key: 'dataConfidence', width: 16 },
      { header: 'Needs Manual Review', key: 'needsManualReview', width: 18 },
      { header: 'Created At', key: 'createdAt', width: 18 },
    ],
    buildCount: (f) => {
      const values: unknown[] = []
      return { text: `SELECT COUNT(*)::int AS n FROM clinics c WHERE ${clinicWhere(f, values)}`, values }
    },
    buildPage: (f, lastId, limit) => {
      const values: unknown[] = []
      const where = clinicWhere(f, values)
      values.push(lastId)
      const idParam = values.length
      values.push(limit)
      return {
        text: `SELECT ${CLINIC_SELECT}
               FROM clinics c
               LEFT JOIN users u ON u.id = c.claimed_by_id
               WHERE ${where} AND c.id > $${idParam}
               ORDER BY c.id
               LIMIT $${values.length}`,
        values,
      }
    },
    hydrate: async (pool, rows, ctx) => {
      if (!rows.length) return
      const ids = rows.map((r) => r.id)
      const [svc, brd, pics, allPics, srcUrls, mediaPics] = await Promise.all([
        pool.query(
          `SELECT r.parent_id, string_agg(DISTINCT s.name, '; ' ORDER BY s.name) AS names
           FROM clinics_rels r JOIN services s ON s.id = r.services_id
           WHERE r.path = 'servicesOffered' AND r.parent_id = ANY($1) GROUP BY r.parent_id`,
          [ids],
        ),
        pool.query(
          `SELECT r.parent_id, string_agg(DISTINCT b.name, '; ' ORDER BY b.name) AS names
           FROM clinics_rels r JOIN brands b ON b.id = r.brands_id
           WHERE r.path = 'brandsOffered' AND r.parent_id = ANY($1) GROUP BY r.parent_id`,
          [ids],
        ),
        pool.query(
          `SELECT _parent_id AS parent_id, COUNT(*)::int AS n
           FROM clinics_clinic_photo_urls WHERE _parent_id = ANY($1) GROUP BY _parent_id`,
          [ids],
        ),
        // The providers aggregate that used to sit here is gone. Both halves of it
        // were removed with the Providers collection: the `providers` table AND
        // the `clinics_rels.providers_id` column. It ran inside this Promise.all
        // with no catch, so every clinic export threw and returned a 500.
        pool.query(
          `SELECT _parent_id AS parent_id, string_agg(url, '; ' ORDER BY _order) AS urls
           FROM clinics_clinic_photo_urls WHERE _parent_id = ANY($1) GROUP BY _parent_id`,
          [ids],
        ),
        pool.query(
          `SELECT _parent_id AS parent_id, string_agg(url, '; ' ORDER BY _order) AS urls
           FROM clinics_source_urls WHERE _parent_id = ANY($1) GROUP BY _parent_id`,
          [ids],
        ),
        pool.query(
          `SELECT r.parent_id, string_agg(DISTINCT m.url, '; ' ORDER BY m.url) AS urls
           FROM clinics_rels r JOIN media m ON m.id = r.media_id
           WHERE r.path = 'photos' AND r.parent_id = ANY($1) GROUP BY r.parent_id`,
          [ids],
        ),
      ])
      const svcMap = new Map(svc.rows.map((r: any) => [r.parent_id, r.names]))
      const brdMap = new Map(brd.rows.map((r: any) => [r.parent_id, r.names]))
      const picMap = new Map(pics.rows.map((r: any) => [r.parent_id, r.n]))
      const allPicsMap = new Map(allPics.rows.map((r: any) => [r.parent_id, r.urls]))
      const srcUrlsMap = new Map(srcUrls.rows.map((r: any) => [r.parent_id, r.urls]))
      const mediaPicsMap = new Map(mediaPics.rows.map((r: any) => [r.parent_id, r.urls]))
      for (const r of rows) {
        r._services = svcMap.get(r.id) ?? ''
        r._brands = brdMap.get(r.id) ?? ''
        r._pics = picMap.get(r.id) ?? 0
        r._allPhotoUrls = allPicsMap.get(r.id) ?? ''
        r._sourceUrls = srcUrlsMap.get(r.id) ?? ''
        r._mediaPhotoUrls = mediaPicsMap.get(r.id) ?? ''
        // Built through lookupSlugs, the same helper getClinicBySlug uses, so this
        // always equals the canonical URL the clinic page declares for itself.
        // Blank rather than a guess when the row has no slug: a URL that 404s is
        // worse in an SEO worksheet than an obviously empty cell.
        if (r.slug && ctx.slugMap) {
          const { citySlug, stateSlug } = lookupSlugs(r.city ?? '', r.state ?? '', ctx.slugMap)
          r._pageUrl = `${ctx.siteUrl}/clinics/${stateSlug}/${citySlug}/${r.slug}`
        } else {
          r._pageUrl = ''
        }
      }
    },
    mapRow: (r) => ({
      iwClinicId: r.clinic_id ?? '',
      lastUpdate: r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 10) : '',
      name: r.clinic_name ?? '',
      type: r.clinic_type ?? '',
      services: r._services ?? '',
      brands: r._brands ?? '',
      phone: r.phone ?? '',
      email: r.email ?? '',
      bookingUrl: r.booking_url ?? '',
      websiteUrl: r.website_url ?? '',
      street: r.address_line1 ?? '',
      city: r.city ?? '',
      state: r.state ?? '',
      zip: r.zip ?? '',
      // Prefer the stored maps URL; fall back to the canonical place-id link.
      gbpLink: r.google_maps_url || (r.google_place_id ? `https://www.google.com/maps/place/?q=place_id:${r.google_place_id}` : ''),
      reviewCount: r.aggregate_rating_count ?? '',
      reviewRating: r.aggregate_rating ?? '',
      reviewUpdated: '',
      picCount: r._pics ?? 0,
      ytUrl: r.youtube_url ?? '',
      liUrl: r.linkedin_url ?? '',
      fbUrl: r.facebook_url ?? '',
      igUrl: r.instagram_url ?? '',
      ttUrl: r.tiktok_url ?? '',
      xUrl: '',
      ownerEmail: r.owner_email ?? '',
      ownerMobile: '',
      ownerLi: '',
      ownerFb: '',
      ownerIh: '',
      ownerTk: '',
      iwClinicUrl: r._pageUrl ?? '',
      slug: r.slug ?? '',
      tagline: r.tagline ?? '',
      description: r.description ?? '',
      acceptsInsurance: r.accepts_insurance ?? false,
      paymentMethods: r.payment_methods ?? '',
      amenities: r.amenities ?? '',
      emailPublic: r.email_public ?? false,
      addressLine2: r.address_line2 ?? '',
      neighborhood: r.neighborhood ?? '',
      county: r.county ?? '',
      country: r.country ?? '',
      latitude: r.latitude != null ? Number(r.latitude) : '',
      longitude: r.longitude != null ? Number(r.longitude) : '',
      googlePlaceId: r.google_place_id ?? '',
      directionsUrl: r.directions_url ?? '',
      appleMapsUrl: r.apple_maps_url ?? '',
      hoursJson: r.hours_json ? JSON.stringify(r.hours_json) : '',
      startingPrice: r.starting_price != null ? Number(r.starting_price) : '',
      logoUrl: r.logo_url ?? '',
      allPhotoUrls: r._allPhotoUrls ?? '',
      mediaPhotoUrls: r._mediaPhotoUrls ?? '',
      subscriptionTier: r.subscription_tier ?? '',
      subscriptionStatus: r.subscription_status ?? '',
      claimed: r.claimed ?? false,
      importBatch: r.import_batch ?? '',
      lastScrapedDate: r.last_scraped_date ? new Date(r.last_scraped_date).toISOString().slice(0, 10) : '',
      sourceUrls: r._sourceUrls ?? '',
      status: r.status ?? '',
      noindex: r.noindex ?? false,
      publishedAt: r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : '',
      dataConfidence: r.data_confidence != null ? Number(r.data_confidence) : '',
      needsManualReview: r.needs_manual_review ?? false,
      createdAt: r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '',
    }),
  },

  services: {
    label: 'Services',
    sheet: 'Services',
    supportsFilters: false,
    columns: [
      { header: 'Name', key: 'name', width: 30 },
      { header: 'Slug', key: 'slug', width: 30 },
      { header: 'URL', key: 'url', width: 50 },
      { header: 'Category', key: 'category', width: 18 },
      { header: 'Tagline', key: 'tagline', width: 50 },
      { header: 'Clinics Offering', key: 'clinicCount', width: 16 },
    ],
    buildCount: () => ({ text: 'SELECT COUNT(*)::int AS n FROM services', values: [] }),
    buildPage: (_f, lastId, limit) => ({
      text: `SELECT s.id, s.name, s.slug, s.category, s.tagline,
                    (SELECT COUNT(*)::int FROM clinics_rels r
                      WHERE r.path = 'servicesOffered' AND r.services_id = s.id) AS clinic_count
             FROM services s WHERE s.id > $1 ORDER BY s.id LIMIT $2`,
      values: [lastId, limit],
    }),
    mapRow: (r, siteUrl) => ({
      name: r.name ?? '',
      slug: r.slug ?? '',
      url: `${siteUrl}/services/${r.slug}`,
      category: r.category ?? '',
      tagline: r.tagline ?? '',
      clinicCount: r.clinic_count ?? 0,
    }),
  },

  brands: {
    label: 'Brands',
    sheet: 'Brands',
    supportsFilters: false,
    columns: [
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Slug', key: 'slug', width: 25 },
      { header: 'URL', key: 'url', width: 45 },
      { header: 'Category', key: 'category', width: 18 },
      { header: 'Manufacturer', key: 'manufacturer', width: 25 },
      { header: 'Clinics Offering', key: 'clinicCount', width: 16 },
    ],
    buildCount: () => ({ text: 'SELECT COUNT(*)::int AS n FROM brands', values: [] }),
    buildPage: (_f, lastId, limit) => ({
      text: `SELECT b.id, b.name, b.slug, b.category, b.manufacturer,
                    (SELECT COUNT(*)::int FROM clinics_rels r
                      WHERE r.path = 'brandsOffered' AND r.brands_id = b.id) AS clinic_count
             FROM brands b WHERE b.id > $1 ORDER BY b.id LIMIT $2`,
      values: [lastId, limit],
    }),
    mapRow: (r, siteUrl) => ({
      name: r.name ?? '',
      slug: r.slug ?? '',
      url: `${siteUrl}/brands/${r.slug}`,
      category: r.category ?? '',
      manufacturer: r.manufacturer ?? '',
      clinicCount: r.clinic_count ?? 0,
    }),
  },

  // Full content audit, same columns for both. See contentExport above.
  guides: contentExport('guides'),
  news: contentExport('news'),

  faqs: {
    label: 'FAQs',
    sheet: 'FAQs',
    supportsFilters: false,
    columns: [
      { header: 'Question', key: 'question', width: 50 },
      { header: 'Answer', key: 'answer', width: 70 },
      { header: 'Category', key: 'category', width: 24 },
      { header: 'Section', key: 'section', width: 14 },
      { header: 'Scope', key: 'scope', width: 14 },
      { header: 'Service', key: 'service', width: 22 },
      { header: 'Brand', key: 'brand', width: 22 },
      { header: 'Location', key: 'location', width: 22 },
      { header: 'Clinic Type', key: 'clinicType', width: 16 },
      { header: 'Review Status', key: 'reviewStatus', width: 16 },
    ],
    // All rows, not just approved: this is a content audit list, not a page list.
    buildCount: () => ({ text: 'SELECT COUNT(*)::int AS n FROM faqs', values: [] }),
    buildPage: (_f, lastId, limit) => ({
      text: `SELECT f.id, f.question, f.answer, f.scope, f.clinic_type, f.review_status, f.section,
                    s.name AS service_name, b.name AS brand_name, l.name AS location_name,
                    fc.name AS category_name
             FROM faqs f
             LEFT JOIN faq_categories fc ON fc.id = f.category_id
             LEFT JOIN services s ON s.id = f.service_id
             LEFT JOIN brands b ON b.id = f.brand_id
             LEFT JOIN locations l ON l.id = f.location_id
             WHERE f.id > $1 ORDER BY f.id LIMIT $2`,
      values: [lastId, limit],
    }),
    mapRow: (r) => ({
      question: r.question ?? '',
      answer: r.answer ?? '',
      category: r.category_name ?? '',
      section: r.section ?? '',
      scope: r.scope ?? '',
      service: r.service_name ?? '',
      brand: r.brand_name ?? '',
      location: r.location_name ?? '',
      clinicType: r.clinic_type ?? '',
      reviewStatus: r.review_status ?? '',
    }),
  },
}

/** Slugs this module can export. Matches the ExportJobs `collectionSlug` options. */
export type ExportableSlug = 'clinics' | 'services' | 'brands' | 'guides' | 'news' | 'faqs'

export const EXPORTABLE = Object.keys(EXPORT_DEFINITIONS) as ExportableSlug[]

/** Narrows an untrusted string to a slug we actually have a definition for. */
export function isExportableSlug(v: unknown): v is ExportableSlug {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(EXPORT_DEFINITIONS, v)
}
