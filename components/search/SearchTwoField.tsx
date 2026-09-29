'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { fetchSuggest, isSearchModifierSuggestion, searchHrefTwoField, type Suggestion } from '@/lib/search-client'

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
              {s.sublabel && <span className="block text-caption text-ink-tertiary truncate">{s.sublabel}</span>}
            </span>
            <span className="text-caption text-ink-tertiary flex-shrink-0">{TYPE_LABEL[s.type]}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * The homepage's two-field search (what + where) on /search (2026-09-30,
 * founder request). Same fields, look and autocomplete as the form in
 * components/hero/HeroSearch.tsx, without the homepage's extras (live
 * results panel, map, trending chips, IP-located prefill): here both fields
 * start from the search on screen. Keep the two forms in step.
 *
 * Replaces the single omnibox this page used, which showed only `q`: a search
 * run from the homepage with a location ("chekfiler" + "33130") came back with
 * "chekfiler" alone in the box, and searching again from it silently dropped
 * the location.
 *
 * A where-suggestion fills the field rather than navigating, as a
 * brand/service suggestion already does, so what was typed in the first
 * field is never thrown away. A new search starts clean: the listing filters
 * are not carried over, as with the omnibox it replaces. A state or city
 * picked in the page's own dropdown is kept while the where field is empty.
 */
export function SearchTwoField({
  defaultWhat = '',
  defaultWhere = '',
  keepPlace,
  autoFocus = false,
  className = '',
}: {
  defaultWhat?: string
  defaultWhere?: string
  /** The page dropdown's state and city, kept when the where field is left empty. */
  keepPlace?: { state?: string; city?: string }
  autoFocus?: boolean
  className?: string
}) {
  const router = useRouter()

  const [whatQuery, setWhatQuery] = useState(defaultWhat)
  const [whatSuggestions, setWhatSuggestions] = useState<Suggestion[]>([])
  const [whatOpen, setWhatOpen] = useState(false)
  const [whatFocusIdx, setWhatFocusIdx] = useState(-1)

  const [whereQuery, setWhereQuery] = useState(defaultWhere)
  const [whereSuggestions, setWhereSuggestions] = useState<Suggestion[]>([])
  const [whereOpen, setWhereOpen] = useState(false)
  const [whereFocusIdx, setWhereFocusIdx] = useState(-1)

  const wrapperRef = useRef<HTMLDivElement>(null)
  const whereInputRef = useRef<HTMLInputElement>(null)

  // A new search on this same page (back, forward, a fresh submit) brings new
  // defaults; the fields follow them rather than keeping the last one typed.
  useEffect(() => setWhatQuery(defaultWhat), [defaultWhat])
  useEffect(() => setWhereQuery(defaultWhere), [defaultWhere])

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

  useEffect(() => {
    const term = whatQuery.trim()
    if (term.length < 2) {
      setWhatSuggestions([])
      return
    }
    const ctrl = new AbortController()
    const id = setTimeout(async () => {
      setWhatSuggestions(await fetchSuggest(term, ctrl.signal, 'service'))
      setWhatFocusIdx(-1)
    }, 180)
    return () => {
      clearTimeout(id)
      ctrl.abort()
    }
  }, [whatQuery])

  useEffect(() => {
    const term = whereQuery.trim()
    if (term.length < 2) {
      setWhereSuggestions([])
      return
    }
    const ctrl = new AbortController()
    const id = setTimeout(async () => {
      setWhereSuggestions(await fetchSuggest(term, ctrl.signal, 'location'))
      setWhereFocusIdx(-1)
    }, 180)
    return () => {
      clearTimeout(id)
      ctrl.abort()
    }
  }, [whereQuery])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setWhatOpen(false)
    setWhereOpen(false)
    const what = whatQuery.trim()
    const where = whereQuery.trim()
    let href = searchHrefTwoField(what, where)
    if (!where && (keepPlace?.state || keepPlace?.city)) {
      const params = new URLSearchParams(href.split('?')[1] ?? '')
      if (keepPlace.state) params.set('state', keepPlace.state)
      if (keepPlace.city) params.set('city', keepPlace.city)
      href = `/search?${params.toString()}`
    }
    if (href !== '/search') router.push(href)
  }

  function pickWhatSuggestion(s: Suggestion) {
    setWhatOpen(false)
    if (isSearchModifierSuggestion(s.type)) {
      // Brand/Service: fill the field; Search runs it.
      setWhatQuery(s.label)
      return
    }
    // A clinic is its own page.
    router.push(s.href)
  }

  function pickWhereSuggestion(s: Suggestion) {
    // Fill, never navigate: navigating dropped what was typed in the first field.
    setWhereQuery(s.label)
    setWhereOpen(false)
  }

  function keyHandler(
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

  return (
    <div className={`max-w-[900px] ${className}`} ref={wrapperRef}>
      <form
        onSubmit={handleSubmit}
        role="search"
        className="flex flex-col md:flex-row gap-3 md:gap-0 md:items-stretch md:bg-surface-canvas md:rounded-control md:shadow-[0_4px_24px_rgba(11,27,52,0.10)] md:border md:border-border md:p-2 relative"
      >
        <div className="relative flex-1 flex items-center gap-3 px-5 py-4 md:py-3 bg-surface-canvas md:bg-transparent rounded-2xl md:rounded-none border md:border-0 border-border shadow-[0_6px_20px_rgba(11,27,52,0.08)] md:shadow-none min-w-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-secondary flex-shrink-0">
            <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            id="search-page-what"
            name="q"
            type="text"
            value={whatQuery}
            onChange={(e) => {
              setWhatQuery(e.target.value)
              setWhatOpen(true)
            }}
            onFocus={() => setWhatOpen(true)}
            onKeyDown={keyHandler(whatSuggestions, whatOpen, whatFocusIdx, setWhatFocusIdx as any, setWhatOpen, pickWhatSuggestion)}
            placeholder="Search for Clinic, Service, Treatment or Brand"
            autoFocus={autoFocus}
            className="flex-1 outline-none text-body bg-transparent text-ink-primary placeholder:text-ink-tertiary placeholder:text-body-sm min-w-0"
            aria-label="What are you looking for"
            aria-expanded={whatOpen}
            aria-autocomplete="list"
            aria-controls="search-page-what-list"
            role="combobox"
          />
          <SuggestList
            id="search-page-what-list"
            open={whatOpen}
            suggestions={whatSuggestions}
            focusIdx={whatFocusIdx}
            onPick={pickWhatSuggestion}
          />
        </div>

        <div className="hidden md:block w-px bg-border-subtle my-1 flex-shrink-0" aria-hidden />

        <div className="relative flex-1 flex items-center gap-3 px-5 py-4 md:py-3 bg-surface-canvas md:bg-transparent rounded-2xl md:rounded-none border md:border-0 border-border shadow-[0_6px_20px_rgba(11,27,52,0.08)] md:shadow-none min-w-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-secondary flex-shrink-0">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
            <circle cx="12" cy="9" r="2.5" />
          </svg>
          <input
            ref={whereInputRef}
            id="search-page-where"
            name="location"
            autoComplete="address-level2"
            type="text"
            value={whereQuery}
            onChange={(e) => {
              setWhereQuery(e.target.value)
              setWhereOpen(true)
            }}
            onFocus={() => setWhereOpen(true)}
            onKeyDown={keyHandler(whereSuggestions, whereOpen, whereFocusIdx, setWhereFocusIdx as any, setWhereOpen, pickWhereSuggestion)}
            placeholder="City, ZIP, or state"
            className="flex-1 outline-none text-body bg-transparent text-ink-primary placeholder:text-ink-tertiary min-w-0"
            aria-label="Where"
            aria-expanded={whereOpen}
            aria-autocomplete="list"
            aria-controls="search-page-where-list"
            role="combobox"
          />
          {whereQuery && (
            <button
              type="button"
              aria-label="Clear location"
              title="Clear location"
              onClick={() => {
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
            id="search-page-where-list"
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
    </div>
  )
}
