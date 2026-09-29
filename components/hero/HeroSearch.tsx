'use client'

import dynamic from 'next/dynamic'
import { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ClinicResultCard, type HeroClinicCard } from './ClinicResultCard'
import {
  fetchSuggest,
  fetchSearchResults,
  searchHrefTwoField,
  isSearchModifierSuggestion,
  type Suggestion,
} from '@/lib/search-client'
import { LazyMapMount } from '@/components/shared/LazyMapMount'

const HeroMap = dynamic(() => import('./HeroMap').then((m) => m.HeroMap), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[380px] md:h-[520px] rounded-2xl bg-surface animate-pulse" />
  ),
})

const DEFAULT_CENTER: [number, number] = [40.7128, -74.006]
/**
 * Two separate chip rows under the search box (client request 2026-07-31).
 * Previously one mixed "Popular:" row. Split by search intent: people searching a
 * brand name and people searching a treatment are different visitors, and the
 * lists are maintained from search-volume data, so they are kept apart.
 * Clicking a chip fills the search field; the visitor can then adjust the
 * location and hit Search.
 *
 * HARD CONSTRAINT: every string below must match a `brands.name` /
 * `services.name` row EXACTLY (case-insensitively). A chip carries no slug and
 * no link. pickPopular just types the string into the search box, and the
 * parser resolves it via buildServiceLookup/buildBrandLookup, which register
 * only the row's name, its slug, and its slug-with-spaces. Anything else falls
 * through to a clinic-NAME search and quietly returns nothing.
 *
 * Audited 2026-09-10 against staging (59 services, 29 brands). Before that,
 * 9 of these 28 chips were dead and one ("Facial Filler") silently resolved to
 * the unrelated "Facial" service, because the lists were written by hand from
 * search-volume data and never checked against the catalog. Re-run that check
 * after any catalog import before adding a chip.
 */
const TRENDING_BRANDS = [
  'Botox', 'Sculptra', 'Dysport', 'Kybella', 'Juvederm', 'Latisse',
  'Xeomin', 'Daxxify', 'Radiesse', 'Restylane', 'Belotero', 'Jeuveau',
]

const TRENDING_SERVICES = [
  'Lip Filler', 'Dermal Filler', 'Laser Treatments', "Crow's Feet", 'Frown Lines',
  'Forehead Lines', 'Neck Bands', 'Chemical Peel', 'Cheek Filler', 'Lower Face Filler',
  'Chin Filler', 'Temple Filler', 'Microneedling', 'Under Eye Filler', 'Jawline Filler',
  'Lip Flip',
]

/**
 * One horizontally scrollable strip of trending chips.
 *
 * The arrows only render when there is somewhere to scroll, and each one hides
 * once that end is reached, so a row that already fits shows no chrome at all.
 * The edge fades follow the same rule. Scroll position is read on mount, on
 * scroll, and on resize, because whether a row overflows depends entirely on the
 * viewport width.
 */
function TrendingRow({
  label,
  items,
  onPick,
}: {
  label: string
  items: string[]
  onPick: (t: string) => void
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const measure = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    // 1px of slack: sub-pixel widths make scrollLeft land just short of the end.
    setCanLeft(el.scrollLeft > 1)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    measure()
    const el = scrollerRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  function nudge(dir: -1 | 1) {
    const el = scrollerRef.current
    if (!el) return
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.7), behavior: 'smooth' })
  }

  const arrow = 'absolute top-1/2 -translate-y-1/2 z-10 w-7 h-7 inline-flex items-center justify-center rounded-full border border-border bg-surface-canvas text-ink-secondary shadow-sm hover:text-brand-accent hover:border-brand-accent transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent'

  return (
    <div className="flex items-center gap-2 text-body-sm">
      <span className="text-ink-tertiary flex-shrink-0">{label}:</span>
      <div className="relative flex-1 min-w-0">
        <div
          ref={scrollerRef}
          onScroll={measure}
          className="flex gap-2 overflow-x-auto hide-scrollbar py-0.5 px-1"
        >
          {items.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onPick(t)}
              className="flex-shrink-0 whitespace-nowrap px-3 py-1.5 rounded-control border border-border bg-surface-canvas text-ink-primary hover:bg-surface hover:border-brand-accent transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
            >
              {t}
            </button>
          ))}
        </div>

        {canLeft && (
          <>
            <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-surface-canvas to-transparent" />
            <button type="button" aria-label={`Scroll ${label} left`} onClick={() => nudge(-1)} className={`${arrow} left-0`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          </>
        )}

        {canRight && (
          <>
            <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-surface-canvas to-transparent" />
            <button type="button" aria-label={`Scroll ${label} right`} onClick={() => nudge(1)} className={`${arrow} right-0`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function toHeroClinic(c: any): HeroClinicCard {
  return {
    id: String(c.id),
    name: c.clinicName,
    slug: c.slug,
    citySlug: c.citySlug ?? '',
    stateSlug: c.stateSlug ?? '',
    neighborhood: c.neighborhood,
    city: c.city,
    state: c.state,
    aggregateRating: c.aggregateRating,
    aggregateRatingCount: c.aggregateRatingCount,
    providerCount: c.providerCount ?? 0,
    latitude: Number(c.latitude) || 0,
    longitude: Number(c.longitude) || 0,
  }
}

const TYPE_LABEL: Record<Suggestion['type'], string> = {
  service: 'Service',
  brand: 'Brand',
  location: 'Location',
  clinic: 'Clinic',
  zip: 'ZIP',
}

function SuggestList({
  id,
  open,
  suggestions,
  focusIdx,
  onPick,
}: {
  id: string
  open: boolean
  suggestions: Suggestion[]
  focusIdx: number
  onPick: (s: Suggestion) => void
}) {
  if (!open || suggestions.length === 0) return null
  return (
    <ul
      id={id}
      role="listbox"
      className="absolute left-0 right-0 top-full mt-2 bg-surface-canvas border border-border rounded-lg shadow-lg z-30 py-2 max-h-[300px] overflow-y-auto"
    >
      {suggestions.map((s, i) => (
        <li key={`${s.type}-${s.href}-${i}`} role="option" aria-selected={i === focusIdx}>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(s)}
            className={`w-full text-left px-4 py-2 flex items-center justify-between gap-3 transition-colors ${
              i === focusIdx ? 'bg-brand-accent-soft' : 'hover:bg-surface'
            }`}
          >
            <span className="min-w-0">
              <span className="block text-body-sm text-ink-primary truncate">{s.label}</span>
              {s.sublabel && (
                <span className="block text-caption text-ink-tertiary truncate">{s.sublabel}</span>
              )}
            </span>
            <span className="text-caption text-ink-tertiary flex-shrink-0">{TYPE_LABEL[s.type]}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function HeroSearch() {
  const router = useRouter()

  // ── What field (treatment / injector / clinic) ────────────────────────────
  const [whatQuery, setWhatQuery] = useState('')
  const [whatSuggestions, setWhatSuggestions] = useState<Suggestion[]>([])
  const [whatOpen, setWhatOpen] = useState(false)
  const [whatFocusIdx, setWhatFocusIdx] = useState(-1)

  // ── Where field (city / ZIP / state) ──────────────────────────────────────
  const [whereQuery, setWhereQuery] = useState('')
  const [whereSuggestions, setWhereSuggestions] = useState<Suggestion[]>([])
  const [whereOpen, setWhereOpen] = useState(false)
  const [whereFocusIdx, setWhereFocusIdx] = useState(-1)

  // ── Live results panel ────────────────────────────────────────────────────
  const [panelOpen, setPanelOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [panelTab, setPanelTab] = useState<'clinics'>('clinics')
  const [countPulse, setCountPulse] = useState(false)
  const [resultClinics, setResultClinics] = useState<HeroClinicCard[]>([])
  const [clinicTotal, setClinicTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState('')
  // The resolved coordinates of the typed location (ZIP/city/state), from the
  // search API's own geocoding -- distinct from pin coordinates. Used to center
  // the map on the searched place even when there are 0 matching pins to plot,
  // and preferred over averaging pins so the map reflects what was searched,
  // not just whatever happened to match.
  const [resolvedCenter, setResolvedCenter] = useState<[number, number] | null>(null)

  const wrapperRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)
  const whereEditedRef = useRef(false)
  // Focused after the clear button wipes the field, so the visitor can type straight away.
  const whereInputRef = useRef<HTMLInputElement>(null)

  // ── Close dropdowns on outside click ──────────────────────────────────────
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setWhatOpen(false)
        setWhereOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  // ── Auto-detect location on load (replaces the old manual "Locate me"
  // button) -- skipped if the user already started typing their own location
  // before the lookup resolves.
  useEffect(() => {
    let cancelled = false
    fetch('/api/geo/ip')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || whereEditedRef.current) return
        if (d.zip && d.city && d.stateCode) setWhereQuery(`${d.zip}, ${d.city}, ${d.stateCode}`)
        else if (d.city && d.stateCode) setWhereQuery(`${d.city}, ${d.stateCode}`)
        else if (d.city) setWhereQuery(d.city)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // ── Debounced what suggestions ─────────────────────────────────────────────
  useEffect(() => {
    const term = whatQuery.trim()
    if (term.length < 2) { setWhatSuggestions([]); return }
    const ctrl = new AbortController()
    const id = setTimeout(async () => {
      const s = await fetchSuggest(term, ctrl.signal, 'service')
      setWhatSuggestions(s)
      setWhatFocusIdx(-1)
    }, 180)
    return () => { clearTimeout(id); ctrl.abort() }
  }, [whatQuery])

  // ── Debounced where suggestions ────────────────────────────────────────────
  useEffect(() => {
    const term = whereQuery.trim()
    if (term.length < 2) { setWhereSuggestions([]); return }
    const ctrl = new AbortController()
    const id = setTimeout(async () => {
      const s = await fetchSuggest(term, ctrl.signal, 'location')
      setWhereSuggestions(s)
      setWhereFocusIdx(-1)
    }, 180)
    return () => { clearTimeout(id); ctrl.abort() }
  }, [whereQuery])

  // ── Debounced live results ─────────────────────────────────────────────────
  useEffect(() => {
    if (!panelOpen) return
    const ctrl = new AbortController()
    setLoading(true)
    const id = setTimeout(async () => {
      const res = await fetchSearchResults(
        { q: whatQuery.trim(), location: whereQuery.trim(), limit: 30 },
        ctrl.signal,
      )
      if (res) {
        setResultClinics(res.clinics.map(toHeroClinic))
        setClinicTotal(res.clinicTotal)
        setResolvedCenter(res.center ? [res.center.lat, res.center.lng] : null)
        setSummary(
          [res.brandLabel || res.serviceLabel, res.locationLabel].filter(Boolean).join(' in ') ||
            whatQuery.trim() ||
            whereQuery.trim(),
        )
      }
      setLoading(false)
    }, 250)
    return () => { clearTimeout(id); ctrl.abort() }
  }, [whatQuery, whereQuery, panelOpen])

  // The directory is clinics-only as of 2026-08-24 (Providers collection removed).
  const headlineCount = clinicTotal
  const headlineNoun = 'verified clinic'

  // ── Count pulse ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!panelOpen) { prevCountRef.current = headlineCount; return }
    if (headlineCount !== prevCountRef.current) {
      setCountPulse(true)
      prevCountRef.current = headlineCount
      const id = setTimeout(() => setCountPulse(false), 350)
      return () => clearTimeout(id)
    }
  }, [headlineCount, panelOpen])

  const effectiveTab = panelTab
  const visibleClinics = showAll ? resultClinics : resultClinics.slice(0, 6)

  const mapCenter: [number, number] = useMemo(() => {
    // Prefer the API's own resolved location (the typed ZIP/city/state's
    // coordinates) so the map reflects what was searched even when there are
    // 0 matching pins -- e.g. a valid location matched 0 results for the
    // typed treatment.
    if (resolvedCenter) return resolvedCenter
    const valid = resultClinics
      .map((c) => [c.latitude, c.longitude] as [number, number])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng))
    if (valid.length === 0) return DEFAULT_CENTER
    const avgLat = valid.reduce((s, [lat]) => s + lat, 0) / valid.length
    const avgLng = valid.reduce((s, [, lng]) => s + lng, 0) / valid.length
    return [avgLat, avgLng]
  }, [resultClinics, resolvedCenter])

  const openPanel = useCallback(() => {
    setPanelOpen(true)
    setWhatOpen(false)
    setWhereOpen(false)
    setTimeout(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const what = whatQuery.trim()
    const where = whereQuery.trim()
    if (what || where) {
      router.push(searchHrefTwoField(what, where))
    } else {
      openPanel()
    }
  }

  function pickWhatSuggestion(s: Suggestion) {
    setWhatOpen(false)
    if (isSearchModifierSuggestion(s.type)) {
      // Brand/Service: just fill the field, like autocomplete -- the user
      // still has to click Search to actually run it. Only Provider/Clinic/
      // Location/ZIP suggestions (a real distinct page) navigate directly.
      setWhatQuery(s.label)
      return
    }
    router.push(s.href)
  }

  function pickWhereSuggestion(s: Suggestion) {
    // Fill the field, then Search runs both (2026-09-30). Navigating to the
    // suggestion's own url threw away what was typed in the first field:
    // "cheek filler" + the "33130, Miami, FL" suggestion searched 33130 alone.
    whereEditedRef.current = true
    setWhereQuery(s.label)
    setWhereOpen(false)
  }

  function pickPopular(t: string) {
    setWhatQuery(t)
    setWhatOpen(false)
  }

  function makeKeyHandler(
    suggestions: Suggestion[],
    open: boolean,
    focusIdx: number,
    setFocusIdx: (fn: (i: number) => number) => void,
    setOpen: (v: boolean) => void,
    onPick: (s: Suggestion) => void,
  ) {
    return (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!open || suggestions.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIdx((i) => Math.min(i + 1, suggestions.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' && focusIdx >= 0) {
        e.preventDefault()
        onPick(suggestions[focusIdx])
      } else if (e.key === 'Escape') {
        setOpen(false)
        setFocusIdx(() => -1)
      }
    }
  }

  const handleWhatKeyDown = makeKeyHandler(
    whatSuggestions, whatOpen, whatFocusIdx,
    setWhatFocusIdx as any, setWhatOpen, pickWhatSuggestion,
  )
  const handleWhereKeyDown = makeKeyHandler(
    whereSuggestions, whereOpen, whereFocusIdx,
    setWhereFocusIdx as any, setWhereOpen, pickWhereSuggestion,
  )

  return (
    <div className="max-w-[900px] mx-auto" ref={wrapperRef}>
      {/* TWO-FIELD SEARCH BAR */}
      <form
        onSubmit={handleSubmit}
        role="search"
        className="flex flex-col md:flex-row gap-3 md:gap-0 md:items-stretch md:bg-surface-canvas md:rounded-control md:shadow-[0_4px_24px_rgba(11,27,52,0.10)] md:border md:border-border md:p-2 relative"
      >
        {/* WHAT field */}
        <div className="relative flex-1 flex items-center gap-3 px-5 py-4 md:py-3 bg-surface-canvas md:bg-transparent rounded-2xl md:rounded-none border md:border-0 border-border shadow-[0_6px_20px_rgba(11,27,52,0.08)] md:shadow-none min-w-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-secondary flex-shrink-0">
            <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            // id/name are what the browser keys autofill and field history on.
            // Without them Chrome reports "A form field element should have an id
            // or name attribute" and declines to remember or restore the value.
            // Safe to add here: the form's onSubmit calls preventDefault, so the
            // browser never performs a native submit and `name` cannot leak into
            // a URL.
            id="hero-search-what"
            name="q"
            type="text"
            value={whatQuery}
            onChange={(e) => { setWhatQuery(e.target.value); setWhatOpen(true) }}
            onFocus={() => setWhatOpen(true)}
            onKeyDown={handleWhatKeyDown}
            placeholder="Search for Clinic, Service, Treatment or Brand"
            className="flex-1 outline-none text-body bg-transparent text-ink-primary placeholder:text-ink-tertiary placeholder:text-body-sm min-w-0"
            aria-label="What are you looking for"
            aria-expanded={whatOpen}
            aria-autocomplete="list"
            aria-controls="hero-what-list"
            role="combobox"
          />
          <SuggestList
            id="hero-what-list"
            open={whatOpen}
            suggestions={whatSuggestions}
            focusIdx={whatFocusIdx}
            onPick={pickWhatSuggestion}
          />
        </div>

        {/* Divider (desktop only) */}
        <div className="hidden md:block w-px bg-border-subtle my-1 flex-shrink-0" aria-hidden />

        {/* WHERE field */}
        <div className="relative flex-1 flex items-center gap-3 px-5 py-4 md:py-3 bg-surface-canvas md:bg-transparent rounded-2xl md:rounded-none border md:border-0 border-border shadow-[0_6px_20px_rgba(11,27,52,0.08)] md:shadow-none min-w-0">
          {/* Location pin icon */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-secondary flex-shrink-0">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
            <circle cx="12" cy="9" r="2.5" />
          </svg>
          <input
            ref={whereInputRef}
            id="hero-search-where"
            name="location"
            // A real location field, so let the browser offer the address-level
            // value it already has rather than treating it as free text.
            autoComplete="address-level2"
            type="text"
            value={whereQuery}
            onChange={(e) => { whereEditedRef.current = true; setWhereQuery(e.target.value); setWhereOpen(true) }}
            onFocus={() => setWhereOpen(true)}
            onKeyDown={handleWhereKeyDown}
            placeholder="City, ZIP, or state"
            className="flex-1 outline-none text-body bg-transparent text-ink-primary placeholder:text-ink-tertiary min-w-0"
            aria-label="Where"
            aria-expanded={whereOpen}
            aria-autocomplete="list"
            aria-controls="hero-where-list"
            role="combobox"
          />
          {/* Clear button (client request 2026-08-01). The location is prefilled
              from the visitor's IP, so the first thing many people need to do is
              wipe a guess they did not ask for. Focus returns to the input so they
              can type straight away. `whereEditedRef` is set so the geo-IP effect
              does not helpfully refill what the user just cleared. */}
          {whereQuery && (
            <button
              type="button"
              aria-label="Clear location"
              title="Clear location"
              onClick={() => {
                whereEditedRef.current = true
                setWhereQuery('')
                setWhereOpen(false)
                whereInputRef.current?.focus()
              }}
              className="flex-shrink-0 w-9 h-9 -mr-1 inline-flex items-center justify-center rounded-full text-ink-secondary hover:text-ink-primary hover:bg-surface transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}

          <SuggestList
            id="hero-where-list"
            open={whereOpen}
            suggestions={whereSuggestions}
            focusIdx={whereFocusIdx}
            onPick={pickWhereSuggestion}
          />
        </div>

        <button
          type="submit"
          className="w-full md:w-auto bg-brand-primary text-surface-canvas rounded-control px-8 py-4 md:py-3.5 text-body font-semibold hover:opacity-90 active:scale-[0.99] transition flex-shrink-0 shadow-[0_8px_20px_rgba(11,27,52,0.18)] md:shadow-none inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="md:hidden">
            <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          Search
        </button>
      </form>

      {/* Trending chips: brands and treatments, one row each (client request
          2026-08-01). They used to wrap onto 2-3 lines each and pushed the page
          down, so each row is now a single horizontally scrollable strip. The
          label stays put while the chips scroll under it, and a fade on the right
          hints there is more when the strip overflows. */}
      <div className="mt-5 space-y-2.5">
        {[
          { label: 'Trending brands', items: TRENDING_BRANDS },
          { label: 'Trending services', items: TRENDING_SERVICES },
        ].map(({ label, items }) => (
          <TrendingRow key={label} label={label} items={items} onPick={pickPopular} />
        ))}
      </div>

      {/* LIVE RESULTS PANEL */}
      <div
        ref={panelRef}
        className="grid transition-[grid-template-rows] duration-500 ease-out"
        style={{ gridTemplateRows: panelOpen ? '1fr' : '0fr' }}
        aria-hidden={!panelOpen}
      >
        <div className="overflow-hidden">
          <div
            className={`mt-8 bg-surface-canvas border border-border rounded-2xl shadow-lg transition-[opacity,transform] duration-500 ease-out ${
              panelOpen ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-4 scale-[0.98]'
            }`}
          >
            {/* Panel header */}
            <div className="flex items-center justify-between gap-3 px-5 md:px-6 py-4 border-b border-border-subtle flex-wrap">
              <div className="flex items-center gap-2 text-body-sm text-ink-secondary">
                <span className="relative flex h-2 w-2 flex-shrink-0">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-brand-accent opacity-75 animate-ping" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-brand-accent" />
                </span>
                <span
                  className={`font-semibold text-ink-primary inline-block transition-transform duration-200 ${
                    countPulse ? 'scale-110' : 'scale-100'
                  }`}
                >
                  {headlineCount}
                </span>
                {` ${headlineNoun}`}{headlineCount === 1 ? '' : 's'}
                {summary ? (
                  <>
                    {' for '}
                    <span className="text-ink-primary font-medium">{summary}</span>
                  </>
                ) : null}
              </div>
              <div className="flex items-center gap-4">
                <Link
                  href={searchHrefTwoField(whatQuery, whereQuery)}
                  className="text-body-sm font-semibold text-brand-accent hover:underline inline-flex items-center gap-1"
                >
                  View full results
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                  </svg>
                </Link>
                <button
                  type="button"
                  onClick={() => setPanelOpen(false)}
                  aria-label="Close results"
                  className="w-8 h-8 rounded-full flex items-center justify-center text-ink-secondary hover:text-ink-primary hover:bg-surface transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="p-4 md:p-6 pb-3 md:pb-4">
              <LazyMapMount
                placeholder={<div className="w-full h-[380px] md:h-[520px] rounded-2xl bg-surface animate-pulse" />}
              >
                <HeroMap
                  clinics={resultClinics}
                  center={mapCenter}
                  activeClinicId={activeId}
                  onPinClick={(id) => setActiveId(id)}
                  visible={panelOpen}
                />
              </LazyMapMount>
            </div>

            <div className="px-4 md:px-6 pb-6">
              {resultClinics.length === 0 ? (
                <div className="text-center py-12 text-ink-secondary">
                  <div className="text-body mb-1">
                    {loading
                      ? 'Searching...'
                      : summary
                        ? `No verified clinics match ${summary}.`
                        : 'No verified clinics match.'}
                  </div>
                  <div className="text-caption text-ink-tertiary">
                    {loading ? 'One moment.' : 'Try a different brand, service, city, or name.'}
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-3 md:gap-4">
                    {visibleClinics.map((c) => (
                      <ClinicResultCard key={c.id} clinic={c} />
                    ))}
                  </div>
                  {resultClinics.length > 6 && (
                    <div className="text-center mt-5">
                      <button
                        type="button"
                        onClick={() => setShowAll((v) => !v)}
                        className="text-body-sm font-medium text-brand-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
                      >
                        {showAll ? 'Show top 6' : `Show ${resultClinics.length} clinics`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
