import Image from 'next/image'
import Link from 'next/link'
import { CoverFallback } from '@/components/shared/CoverFallback'

/**
 * The one guide card. Used by the homepage "Educational Guides" section and by
 * the /guides listing, so the two can never drift apart again.
 *
 * Client request 2026-08-06: cover is 16:9, the date moved above the title, and
 * the divider rule (plus the dead space under it) at the bottom is gone. The
 * author / medical-reviewer byline was dropped from the card at the same time.
 * Only some guides carry a reviewer, so the row left half the grid looking
 * empty. Both bylines still run on the guide page itself.
 *
 * The two callers hand over different types (GuideRow from home-queries,
 * GuideCard from guide-queries); both satisfy the field set below.
 */
export type GuideListingCardData = {
  id: string
  title: string
  slug: string
  lede: string
  coverImageUrl?: string
  readTimeMin?: number
  publishedAt?: string
  lastMedicallyReviewed?: string
}

export function GuideListingCard({
  guide,
  index,
  headingLevel = 3,
}: {
  guide: GuideListingCardData
  /** Pass to stagger the fade-up entrance. Omit on filtered listings, where
      re-running the animation on every tab switch reads as a flicker. */
  index?: number
  /** 3 under a section <h2> (homepage), 2 on a listing page that only has an <h1>. */
  headingLevel?: 2 | 3
}) {
  // Real publish date when the guide has one. The July 2026 content refresh
  // never set publishedAt, so live guides can have it empty; the review date is
  // the fallback rather than showing no date at all.
  const dateSource = guide.publishedAt ?? guide.lastMedicallyReviewed
  const date = dateSource ? new Date(dateSource) : null
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  const animated = index !== undefined

  return (
    <Link
      href={`/guides/${guide.slug}`}
      style={animated ? { animationDelay: `${Math.min(index, 6) * 60}ms` } : undefined}
      className={`group bg-surface-canvas border border-border rounded-2xl overflow-hidden block transition hover:shadow-hover hover:-translate-y-1 duration-300 ${
        animated ? 'animate-fade-up' : ''
      }`}
    >
      <div className="relative w-full aspect-[16/9] bg-surface overflow-hidden">
        {guide.coverImageUrl ? (
          <Image
            src={guide.coverImageUrl}
            alt={guide.title}
            fill
            sizes="(min-width:1024px) 33vw, (min-width:768px) 50vw, 100vw"
            className="object-cover transition-transform duration-700 group-hover:scale-105"
          />
        ) : (
          <CoverFallback label="Guide" />
        )}
      </div>

      <div className="p-6">
        {(date || guide.readTimeMin) && (
          <div className="flex items-center gap-3 mb-2 text-caption text-ink-tertiary">
            {date && (
              <span className="flex items-center gap-1">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
                </svg>
                {date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
              </span>
            )}
            {guide.readTimeMin && (
              <span className="flex items-center gap-1">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
                {guide.readTimeMin} min read
              </span>
            )}
          </div>
        )}

        <Heading className="font-serif text-h3-m mb-2 text-ink-primary leading-tight line-clamp-2 group-hover:text-brand-accent transition">
          {guide.title}
        </Heading>
        <p className="text-body-sm text-ink-secondary leading-[1.55] line-clamp-3">{guide.lede}</p>
      </div>
    </Link>
  )
}
