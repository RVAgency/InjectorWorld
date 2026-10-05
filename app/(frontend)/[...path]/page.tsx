import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { resolveRoute, getAllRoutePaths } from '@/lib/route-resolver'
import {
  getCityDirectory, getServicePillar, getServiceState, getServicesIndex,
} from '@/lib/location-queries'
import {
  getBrandsIndex, getBrandPillar, getBrandState, getBrandCityDirectory,
} from '@/lib/brand-queries'
import { getActiveBanner } from '@/lib/promotions'
import { getPageRobots } from '@/lib/page-index/queries'
import { buildPageMetadata, withTitleSuffix, countWord, COMPARE_TAIL } from '@/lib/seo-metadata'
import { webPageRef, pageItemList, clinicItemList, brandEntity } from '@/lib/json-ld'
import { CityDirectoryPage } from '@/components/pages/CityDirectoryPage'
import { ServicePillarPage } from '@/components/pages/ServicePillarPage'
import { ServiceStatePage } from '@/components/pages/ServiceStatePage'
import { ServicesIndexPage } from '@/components/pages/ServicesIndexPage'
import { BrandsIndexPage } from '@/components/pages/BrandsIndexPage'
import { BrandPillarPage } from '@/components/pages/BrandPillarPage'
import { BrandStatePage } from '@/components/pages/BrandStatePage'
import { BrandCityDirectoryPage } from '@/components/pages/BrandCityDirectoryPage'

export const revalidate = 600

/** One string for the service pillar's meta description and its MedicalWebPage
 *  description, so the two can never drift apart. */
function servicePillarDescription(name: string): string {
  return `Find verified providers offering ${name} near you. ${COMPARE_TAIL}`
}

export async function generateStaticParams() {
  try {
    const paths = await getAllRoutePaths()
    return paths.map((p) => ({ path: p }))
  } catch {
    return []
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ path: string[] }>
}): Promise<Metadata> {
  const { path } = await params
  const resolved = await resolveRoute(path)
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://injector.world'

  if (resolved.type === 'services-index') {
    const title = 'All aesthetic services'
    const desc = 'Browse every aesthetic treatment we cover, from neurotoxins to fillers and skin therapies. Find verified, license-checked injectors near you.'
    // buildPageMetadata (2026-09-25): the hand-built openGraph here had no
    // og:type or og:site_name. Same title, description and canonical as before.
    return buildPageMetadata({ title: `${title} | injector.world`, description: desc, url: `${siteUrl}/services`, imageAlt: title })
  }

  if (resolved.type === 'brands-index') {
    const title = 'Aesthetic product brands'
    const desc = 'Browse aesthetic product brands: Botox, Juvederm, Dysport, Sculptra, and more. Find verified clinics that carry each brand.'
    return buildPageMetadata({ title: `${title} | injector.world`, description: desc, url: `${siteUrl}/brands`, imageAlt: title })
  }

  if (resolved.type === 'brand-pillar') {
    const data = await getBrandPillar(resolved.brandSlug)
    if (!data) return {}
    const path = `/brands/${resolved.brandSlug}`
    return buildPageMetadata({
      title: withTitleSuffix(`${data.brand.name} Injectors Near You`),
      description: `Find verified ${data.brand.name} injectors near you. ${COMPARE_TAIL}`,
      url: `${siteUrl}${path}`,
      imageAlt: `${data.brand.name} injectors near you`,
      robots: await getPageRobots(path),
    })
  }

  if (resolved.type === 'brand-state') {
    const data = await getBrandState(resolved.brandSlug, resolved.stateSlug)
    if (!data) return {}
    const path = `/brands/${resolved.brandSlug}/${resolved.stateSlug}`
    return buildPageMetadata({
      title: withTitleSuffix(`${data.brand.name} Injectors in ${data.state.name}`),
      description: `Find ${countWord(data.totalClinics)}verified clinics offering ${data.brand.name} in ${data.state.name}. ${COMPARE_TAIL}`,
      url: `${siteUrl}${path}`,
      imageAlt: `${data.brand.name} injectors in ${data.state.name}`,
      robots: await getPageRobots(path),
    })
  }

  if (resolved.type === 'brand-city-directory') {
    const data = await getBrandCityDirectory(resolved.brandSlug, resolved.stateSlug, resolved.citySlug)
    if (!data) return {}
    const city = data.city.name.replace(/\s+city$/i, '')
    const path = `/brands/${resolved.brandSlug}/${resolved.stateSlug}/${resolved.citySlug}`
    return buildPageMetadata({
      title: withTitleSuffix(`${data.brand.name} Injectors in ${city}, ${data.city.stateCode}`),
      description: `Find ${countWord(data.totalClinics)}verified clinics offering ${data.brand.name} in ${city}, ${data.city.stateCode}. ${COMPARE_TAIL}`,
      url: `${siteUrl}${path}`,
      imageAlt: `${data.brand.name} injectors in ${city}, ${data.city.stateCode}`,
      // Path, not the full url: page_index stores paths. Passing the canonical
      // url here made every brand-city page noindex forever (fixed 2026-09-17).
      robots: await getPageRobots(path),
    })
  }

  if (resolved.type === 'service-city-directory') {
    const data = await getCityDirectory(resolved.serviceSlug, resolved.stateSlug, resolved.citySlug)
    if (!data) return {}
    const name = data.service.name
    const city = data.city.name.replace(/\s+city$/i, '')
    const place = `${city}, ${data.city.stateCode}`
    const path = `/services/${resolved.serviceSlug}/${resolved.stateSlug}/${resolved.citySlug}`
    return buildPageMetadata({
      title: withTitleSuffix(`${name} Injectors in ${place}`),
      description: `Find ${countWord(data.totalClinics)}verified clinics offering ${name} in ${place}. ${COMPARE_TAIL}`,
      url: `${siteUrl}${path}`,
      imageAlt: `${name} injectors in ${place}`,
      robots: await getPageRobots(path),
    })
  }

  if (resolved.type === 'service-pillar') {
    const data = await getServicePillar(resolved.serviceSlug)
    if (!data) return {}
    const name = data.service.name
    const path = `/services/${resolved.serviceSlug}`
    return buildPageMetadata({
      title: withTitleSuffix(`${name} Injectors Near You`),
      description: servicePillarDescription(name),
      url: `${siteUrl}${path}`,
      imageAlt: `${name} injectors near you`,
      robots: await getPageRobots(path),
    })
  }

  if (resolved.type === 'service-state') {
    const data = await getServiceState(resolved.serviceSlug, resolved.stateSlug)
    if (!data) return {}
    const name = data.service.name
    const path = `/services/${resolved.serviceSlug}/${resolved.stateSlug}`
    return buildPageMetadata({
      title: withTitleSuffix(`${name} Injectors in ${data.state.name}`),
      description: `Find ${countWord(data.totalClinics)}verified clinics offering ${name} in ${data.state.name}. ${COMPARE_TAIL}`,
      url: `${siteUrl}${path}`,
      imageAlt: `${name} injectors in ${data.state.name}`,
      robots: await getPageRobots(path),
    })
  }

  return {}
}

export default async function CatchAllPage({
  params,
}: {
  params: Promise<{ path: string[] }>
}) {
  const { path } = await params
  const resolved = await resolveRoute(path)
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://injector.world'

  // ── Brands index (/brands) ─────────────────────────────────────────────────
  if (resolved.type === 'brands-index') {
    const brands = await getBrandsIndex()
    const schema = [{
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
        { '@type': 'ListItem', position: 2, name: 'Brands', item: `${siteUrl}/brands` },
      ],
    }, {
      '@context': 'https://schema.org', '@type': 'ItemList',
      name: 'Aesthetic product brands',
      numberOfItems: brands.length,
      itemListElement: brands.map((b, i) => ({
        '@type': 'ListItem', position: i + 1, name: b.name, url: `${siteUrl}/brands/${b.slug}`,
      })),
    }]
    return <BrandsIndexPage brands={brands} schema={schema} />
  }

  // ── Brand pillar (/brands/[brand]) ─────────────────────────────────────────
  if (resolved.type === 'brand-pillar') {
    const data = await getBrandPillar(resolved.brandSlug)
    if (!data) notFound()
    const pageUrl = `${siteUrl}/brands/${resolved.brandSlug}`
    const schema = [{
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
        { '@type': 'ListItem', position: 2, name: 'Brands', item: `${siteUrl}/brands` },
        { '@type': 'ListItem', position: 3, name: data.brand.name },
      ],
    },
    brandEntity(data.brand, pageUrl),
    // The states in the hero's LocationPicker, the same list and order.
    pageItemList(`${data.brand.name} Injectors by state`, pageUrl, data.states.map((s) => ({
      name: `${data.brand.name} Injectors in ${s.name}`,
      url: `${pageUrl}/${s.slug}`,
    })))].filter((s): s is NonNullable<typeof s> => s !== null)
    // No FAQPage here: the FAQ block is a preview, and its schema lives on
    // /faq/<category> only (docs/FAQ-SYSTEM-2026-09-13.md). The SEO expert's
    // 2026-10-05 spec asked for one; skipped by founder decision the same day.
    return <BrandPillarPage data={data} schema={schema} />
  }

  // ── Brand × state (/brands/[brand]/[state]) ────────────────────────────────
  if (resolved.type === 'brand-state') {
    const data = await getBrandState(resolved.brandSlug, resolved.stateSlug)
    if (!data) notFound()
    const schema = [{
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
        { '@type': 'ListItem', position: 2, name: 'Brands', item: `${siteUrl}/brands` },
        { '@type': 'ListItem', position: 3, name: data.brand.name, item: `${siteUrl}/brands/${resolved.brandSlug}` },
        { '@type': 'ListItem', position: 4, name: data.state.name },
      ],
    },
    // Every city in the picker and the city grid, same order.
    pageItemList(
      `${data.brand.name} Injectors by city in ${data.state.name}`,
      `${siteUrl}/brands/${resolved.brandSlug}/${resolved.stateSlug}`,
      data.cities.map((c) => ({
        name: `${data.brand.name} Injectors in ${c.name}, ${data.state.name}`,
        url: `${siteUrl}/brands/${resolved.brandSlug}/${resolved.stateSlug}/${c.slug}`,
      })),
    )].filter((s): s is NonNullable<typeof s> => s !== null)
    return <BrandStatePage data={data} schema={schema} />
  }

  // ── Brand × city (/brands/[brand]/[state]/[city]) ──────────────────────────
  if (resolved.type === 'brand-city-directory') {
    const data = await getBrandCityDirectory(resolved.brandSlug, resolved.stateSlug, resolved.citySlug)
    if (!data) notFound()
    const cityDisplay = data.city.name.replace(/\s+city$/i, '')
    const schema = [{
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
        { '@type': 'ListItem', position: 2, name: 'Brands', item: `${siteUrl}/brands` },
        { '@type': 'ListItem', position: 3, name: data.brand.name, item: `${siteUrl}/brands/${resolved.brandSlug}` },
        ...(data.stateLocation ? [{ '@type': 'ListItem', position: 4, name: data.stateLocation.name, item: `${siteUrl}/brands/${resolved.brandSlug}/${resolved.stateSlug}` }] : []),
        { '@type': 'ListItem', position: data.stateLocation ? 5 : 4, name: cityDisplay },
      ],
    },
    // The page-1 clinic grid as served (founder decision 2026-10-05).
    clinicItemList(
      `${data.brand.name} clinics in ${cityDisplay}${data.stateLocation ? `, ${data.stateLocation.name}` : ''}`,
      `${siteUrl}/brands/${resolved.brandSlug}/${resolved.stateSlug}/${resolved.citySlug}`,
      siteUrl,
      data.clinics,
    )].filter((s): s is NonNullable<typeof s> => s !== null)
    return <BrandCityDirectoryPage data={data} schema={schema} />
  }

  // ── Services index (/services) ──────────────────────────────────────────────
  if (resolved.type === 'services-index') {
    const services = await getServicesIndex()
    const schema = [{
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
        { '@type': 'ListItem', position: 2, name: 'Services', item: `${siteUrl}/services` },
      ],
    }, {
      '@context': 'https://schema.org', '@type': 'ItemList',
      name: 'Aesthetic services',
      numberOfItems: services.length,
      itemListElement: services.map((s, i) => ({
        '@type': 'ListItem', position: i + 1, name: s.name, url: `${siteUrl}/services/${s.slug}`,
      })),
    }]
    return <ServicesIndexPage services={services} schema={schema} />
  }

  // ── Service × city directory (money page) ───────────────────────────────────
  if (resolved.type === 'service-city-directory') {
    const data = await getCityDirectory(resolved.serviceSlug, resolved.stateSlug, resolved.citySlug)
    if (!data) notFound()

    const banner = await getActiveBanner('service+city', data.service.id, undefined, data.city.id)

    const cityDisplay = data.city.name.replace(/\s+city$/i, '')

    const breadcrumbSchema = {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        // Home / Services / <service> / <state> / <city>. Kept identical to the
        // visible trail in CityDirectoryPage and to the brand city page's shape.
        // Until 2026-09-10 this described a different trail from the one on the
        // page, which is exactly what structured data must not do.
        { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
        { '@type': 'ListItem', position: 2, name: 'Services', item: `${siteUrl}/services` },
        { '@type': 'ListItem', position: 3, name: data.service.name, item: `${siteUrl}/services/${resolved.serviceSlug}` },
        ...(data.stateLocation ? [
          { '@type': 'ListItem', position: 4, name: data.stateLocation.name, item: `${siteUrl}/services/${resolved.serviceSlug}/${data.stateLocation.slug}` },
        ] : []),
        { '@type': 'ListItem', position: data.stateLocation ? 5 : 4, name: data.city.name },
      ],
    }

    // The page-1 clinic grid as served (founder decision 2026-10-05). Was the
    // first 10 rows while numberOfItems counted all of page 1, so the list and
    // its own count disagreed.
    const clinicListSchema = clinicItemList(
      `${data.service.name} clinics in ${cityDisplay}${data.stateLocation ? `, ${data.stateLocation.name}` : ''}`,
      `${siteUrl}/services/${resolved.serviceSlug}/${resolved.stateSlug}/${resolved.citySlug}`,
      siteUrl,
      data.clinics,
    )

    return (
      <CityDirectoryPage
        data={data}
        banner={banner}
        schema={[breadcrumbSchema, ...(clinicListSchema ? [clinicListSchema] : [])]}
      />
    )
  }

  // ── Service pillar ───────────────────────────────────────────────────────────
  if (resolved.type === 'service-pillar') {
    const data = await getServicePillar(resolved.serviceSlug)
    if (!data) notFound()

    const banner = await getActiveBanner('service', data.service.id, undefined, undefined)

    const pageUrl = `${siteUrl}/services/${resolved.serviceSlug}`
    const schema = [{
      '@context': 'https://schema.org', '@type': 'MedicalWebPage',
      name: `${data.service.name} Injectors`,
      url: pageUrl,
      mainEntityOfPage: webPageRef(pageUrl),
      // The page's own meta description. Was shortDescription || tagline, which
      // left the key out entirely on services with neither (e.g. /services/abdomen).
      description: servicePillarDescription(data.service.name),
      specialty: 'Dermatology',
    }, {
      // Added 2026-09-24: the service pillar was the one level of the three
      // paths with a visible trail and no BreadcrumbList. Same shape as the
      // brand pillar above, and the same trail ServicePillarPage renders.
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
        { '@type': 'ListItem', position: 2, name: 'Services', item: `${siteUrl}/services` },
        { '@type': 'ListItem', position: 3, name: data.service.name },
      ],
    },
    // The states in the hero's LocationPicker, the same list and order.
    pageItemList(`${data.service.name} Injectors by state`, pageUrl, data.states.map((s) => ({
      name: `${data.service.name} Injectors in ${s.name}`,
      url: `${pageUrl}/${s.slug}`,
    })))].filter((s): s is NonNullable<typeof s> => s !== null)

    return <ServicePillarPage data={data} banner={banner} schema={schema} />
  }

  // ── Service × state ───────────────────────────────────────────────────────────
  if (resolved.type === 'service-state') {
    const data = await getServiceState(resolved.serviceSlug, resolved.stateSlug)
    if (!data) notFound()

    const banner = await getActiveBanner('service+state', data.service.id, data.state.id, undefined)

    const schema = [{
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        // Home / Services / <service> / <state>, matching the visible trail in
        // ServiceStatePage and the brand state page's shape.
        { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
        { '@type': 'ListItem', position: 2, name: 'Services', item: `${siteUrl}/services` },
        { '@type': 'ListItem', position: 3, name: data.service.name, item: `${siteUrl}/services/${resolved.serviceSlug}` },
        { '@type': 'ListItem', position: 4, name: data.state.name },
      ],
    },
    // Every city in the picker and the city grid, same order. Items are the
    // city pages, so WebPage, not City (a City entity has no page url of ours).
    pageItemList(
      `${data.service.name} Injectors by city in ${data.state.name}`,
      `${siteUrl}/services/${resolved.serviceSlug}/${resolved.stateSlug}`,
      data.cities.map((c) => ({
        name: `${data.service.name} Injectors in ${c.name}, ${data.state.name}`,
        url: `${siteUrl}/services/${resolved.serviceSlug}/${resolved.stateSlug}/${c.slug}`,
      })),
    )].filter((s): s is NonNullable<typeof s> => s !== null)

    return <ServiceStatePage data={data} banner={banner} schema={schema} />
  }

  notFound()
}
