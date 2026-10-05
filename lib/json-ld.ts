/**
 * Shared Schema.org builders for the listing, guide and news templates.
 *
 * Shapes follow the SEO expert's per-template spec of 2026-10-05: every main
 * entity points at its page through `mainEntityOfPage`, and every listing page
 * carries an ItemList of exactly the links it renders (states on a pillar,
 * cities on a state page, the page-1 clinic grid on a city page).
 */

export function webPageRef(url: string) {
  return { '@type': 'WebPage', '@id': url }
}

/** ItemList of child listing pages (states or cities). Null when there is
 *  nothing to list, so callers can filter it out. */
export function pageItemList(name: string, url: string, items: Array<{ name: string; url: string }>) {
  if (items.length === 0) return null
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    url,
    numberOfItems: items.length,
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: { '@type': 'WebPage', name: it.name, url: it.url },
    })),
  }
}

type ListedClinic = { clinicName: string; slug: string; stateSlug: string; citySlug: string }

/** ItemList of the clinics in a city page's page-1 grid, the same rows the
 *  served HTML renders. `numberOfItems` is the length of this list, not the
 *  city total: the list and the count must agree. */
export function clinicItemList(name: string, url: string, siteUrl: string, clinics: ListedClinic[]) {
  if (clinics.length === 0) return null
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    url,
    numberOfItems: clinics.length,
    itemListElement: clinics.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'MedicalBusiness',
        name: c.clinicName,
        url: `${siteUrl}/clinics/${c.stateSlug}/${c.citySlug}/${c.slug}`,
      },
    })),
  }
}

/**
 * Brand entity by category. Neurotoxins are drugs and fillers and
 * biostimulators are FDA devices, so those two map cleanly. Skin and body are
 * mixed (Latisse and Kybella are drugs, Ultherapy and CoolSculpting are
 * devices, ZO Skin Health is skincare), so they get no entity rather than a
 * wrong one. `manufacturer` is a Drug property, not a MedicalDevice one.
 */
export function brandEntity(
  brand: { name: string; category: string; manufacturer?: string; shortDescription?: string; tagline?: string },
  url: string,
) {
  const type =
    brand.category === 'neurotoxin' ? 'Drug'
      : brand.category === 'filler' || brand.category === 'biostimulator' ? 'MedicalDevice'
        : null
  if (!type) return null
  const description = brand.shortDescription || brand.tagline
  return {
    '@context': 'https://schema.org',
    '@type': type,
    name: brand.name,
    url,
    ...(description ? { description } : {}),
    mainEntityOfPage: webPageRef(url),
    ...(type === 'Drug' && brand.manufacturer
      ? { manufacturer: { '@type': 'Organization', name: brand.manufacturer } }
      : {}),
  }
}

/**
 * Article author. The house byline ("injector.world Editorial Team", or the
 * "injector.world Editorial" fallback when no author is set) is an
 * Organization; a named person stays a Person, so the markup always matches
 * the visible byline.
 */
export function articleAuthor(author: { fullName: string; linkedinUrl?: string }, siteUrl: string) {
  if (/^injector\.?world\b/i.test(author.fullName.trim())) {
    return { '@type': 'Organization', name: author.fullName, url: siteUrl }
  }
  return {
    '@type': 'Person',
    name: author.fullName,
    ...(author.linkedinUrl ? { url: author.linkedinUrl } : {}),
  }
}
