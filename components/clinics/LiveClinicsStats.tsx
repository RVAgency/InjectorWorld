'use client'

import { usePathname } from 'next/navigation'
import { useLiveListing } from '@/lib/listing-count-store'

/**
 * The /clinics hero stats (Clinics listed, States, Average rating), following
 * the listing below (2026-09-28). Server render and first paint show the
 * page's own national figures; once the listing reports, the figures are for
 * the clinics actually listed: the visitor's ZIP and radius, or the filters.
 *
 * Lives inside the always-dark navy hero, so it keeps `text-white` and never
 * uses `text-ink-*` (CLAUDE.md, page furniture).
 */
export function LiveClinicsStats({
  initial,
}: {
  initial: { total: number; stateCount: number; avgRating: string }
}) {
  const pathname = usePathname()
  const live = useLiveListing(pathname)
  const total = live && typeof live.total === 'number' ? live.total : initial.total
  const stats = live?.stats ?? { stateCount: initial.stateCount, avgRating: initial.avgRating }
  const pending = Boolean(live?.pending)

  return (
    <div
      className={`flex flex-wrap gap-6 mt-10 pt-10 border-t border-white/10${pending ? ' animate-pulse' : ''}`}
      // Before the listing first reports, the pre-paint near-me CSS hides the
      // figures (app/globals.css), as it does the pill on the other pillars.
      data-live-count={live ? undefined : 'nearme'}
      aria-busy={pending || undefined}
    >
      {[
        { n: total.toLocaleString(), label: 'Clinics listed' },
        { n: stats.stateCount.toLocaleString(), label: 'States' },
        { n: stats.avgRating, label: 'Average rating' },
      ].map(({ n, label }) => (
        <div key={label} className={pending ? 'invisible' : undefined}>
          <div className="font-semibold text-[28px] leading-none text-white">{n}</div>
          <div className="text-caption text-white/60 mt-1">{label}</div>
        </div>
      ))}
    </div>
  )
}
