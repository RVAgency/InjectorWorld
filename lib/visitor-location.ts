import 'server-only'
import { geoFromCloudflare, lookupGeo } from './geo-ip'
import { getIp } from './rate-limit'
import { lookupZip } from './zip-lookup'
import { getPayloadInstance } from './payload-server'

/**
 * The centre of the visitor's ZIP, for a "near me" search (2026-09-28).
 *
 * Same rules as /api/geo/ip?centre=1, which the near-me listings use: a US ZIP
 * only (a PIN code from another country can look like a real US ZIP), and the
 * ZIP's own centre from zip_codes, never the raw IP point. Returns null when
 * the visitor cannot be placed, and the caller then searches nationwide.
 *
 * Only ever call this for a response that is not shared between visitors
 * (/search, /api/search/more). /api/search is cached at the CDN by url.
 */
export async function visitorZipCentre(
  headers: Headers,
): Promise<{ lat: number; lng: number; label: string; zip: string } | null> {
  try {
    const geo = geoFromCloudflare(headers) ?? (await lookupGeo(getIp({ headers } as Parameters<typeof getIp>[0])))
    if (geo.country !== 'US' || !geo.zip || !/^\d{5}$/.test(geo.zip)) return null
    const payload = await getPayloadInstance()
    const hit = await lookupZip(geo.zip, (payload.db as any).pool)
    return hit ? { lat: hit.lat, lng: hit.lng, label: hit.label, zip: geo.zip } : null
  } catch {
    return null
  }
}
