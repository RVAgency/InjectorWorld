'use client'

import { usePathname } from 'next/navigation'
import { useLiveListing } from '@/lib/listing-count-store'
import { CountPill } from './CountPill'

/**
 * The page hero's count pill, following the listing below it (2026-09-28).
 *
 * Renders `initial` (the page's server number) on the server and until the
 * listing reports; from then on it shows the listing's own total, so a
 * near-me list of 131 clinics is never headed "51,227 clinics". See
 * lib/listing-count-store.ts.
 *
 * `singular` is used for a total of exactly 1; the plural label is otherwise
 * shown unchanged.
 */
export function LiveCountPill({
  initial,
  label,
  singular,
  nearMe = false,
}: {
  initial: number
  label: string
  singular?: string
  nearMe?: boolean
}) {
  const pathname = usePathname()
  const live = useLiveListing(pathname)
  const count = live && typeof live.total === 'number' ? live.total : initial
  return (
    <CountPill
      count={count}
      label={count === 1 && singular ? singular : label}
      pending={Boolean(live?.pending)}
      // Only until the listing first reports: the pre-paint CSS hides the pill
      // while the near-me list is hidden, and from the first report on the
      // listing's own `pending` decides, as the list's own marker does.
      nearMe={nearMe && !live}
    />
  )
}
