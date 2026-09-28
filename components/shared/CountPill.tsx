/**
 * `pending` (2026-09-28): the count is being re-queried. The pill keeps its
 * size and pulses with the text hidden, so nothing moves and no stale number is
 * shown under a fresh selection.
 *
 * `nearMe`: the pill sits above a near-me listing. The same CSS that hides that
 * listing before first paint (html[data-near-me='pending'], see
 * components/shared/NearMeBoot.tsx and app/globals.css) then pulses the pill,
 * so the national number in the served HTML is never flashed at a visitor
 * whose local list is about to load.
 */
export function CountPill({
  count,
  label,
  pending = false,
  nearMe = false,
}: {
  count: number
  label: string
  pending?: boolean
  nearMe?: boolean
}) {
  return (
    <span
      className={`px-3 py-1.5 rounded-control bg-brand-accent-soft text-brand-accent text-body-sm font-medium${pending ? ' animate-pulse' : ''}`}
      data-live-count={nearMe ? 'nearme' : undefined}
      aria-busy={pending || undefined}
    >
      <span className={pending ? 'invisible' : undefined}>
        {count.toLocaleString()} {label}
      </span>
    </span>
  )
}
