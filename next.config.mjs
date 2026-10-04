import { withPayload } from '@payloadcms/next/withPayload'

// CSP: covers Next.js inline scripts (nonces not used), Google Fonts, Google Maps tiles,
// Unsplash/Pravatar images, DO Spaces CDN, and Payload admin.
//
// DEV NOTE: Next.js dev mode (React Fast Refresh / HMR) requires 'unsafe-eval' and
// a websocket connection. Without them a strict browser blocks eval and hydration
// silently dies (cards stay invisible, theme toggle never mounts, nothing is
// interactive). Production does NOT use eval, so prod keeps the tight policy.
const isDev = process.env.NODE_ENV !== 'production'

// Public origin that serves uploaded media (Cloudflare R2 today). The managed
// pub-xxxx.r2.dev domain is covered by the *.r2.dev wildcard; a custom domain
// (e.g. media.injector.world) is picked up from R2_PUBLIC_URL with no code
// change. Returns the bare https origin, or null when unset.
const r2PublicUrl = (() => {
  try {
    return process.env.R2_PUBLIC_URL ? new URL(process.env.R2_PUBLIC_URL) : null
  } catch {
    return null
  }
})()
const r2PublicOrigin = r2PublicUrl ? r2PublicUrl.origin : null
const r2PublicHostname = r2PublicUrl ? r2PublicUrl.hostname : null

const csp = [
  "default-src 'self'",
  // Inline scripts needed for JSON-LD schema blocks and Next.js hydration.
  // 'unsafe-eval' is dev-only (Fast Refresh); never shipped to production.
  // Cloudflare Turnstile CAPTCHA widget is loaded from challenges.cloudflare.com.
  // Google Maps JS API bootstraps itself via a <script src="maps.googleapis.com">
  // tag that then injects further script elements from maps.gstatic.com.
  `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://*.googletagmanager.com https://maps.googleapis.com https://*.gstatic.com${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  [
    "img-src 'self' data: blob:",
    'https://picsum.photos',
    'https://fastly.picsum.photos',
    'https://i.pravatar.cc',
    'https://images.unsplash.com',
    'https://media.alle.com',
    'https://lh3.googleusercontent.com',
    // Google Maps JS API: tiles, sprites, static street view thumbnails.
    'https://*.googleapis.com',
    'https://*.gstatic.com',
    'https://*.ggpht.com',
    'https://*.digitaloceanspaces.com',
    // Uploaded media (Cloudflare R2): managed r2.dev domain + any custom domain.
    'https://*.r2.dev',
    ...(r2PublicOrigin ? [r2PublicOrigin] : []),
    // Google Tag Manager / Analytics (GA4 pixel + doubleclick).
    //
    // KNOWN, DELIBERATE CONSOLE WARNING. With Google Signals (ads
    // personalisation) enabled, GA4 also fires a remarketing pixel at the
    // visitor's LOCAL Google domain — google.co.in from India, google.de from
    // Germany, and so on. Those are ccTLDs, so `https://*.google.com` does not
    // cover them and the browser logs:
    //
    //   Loading the image 'https://www.google.co.in/ads/ga-audiences?...'
    //   violates the following Content Security Policy directive: "img-src ..."
    //
    // Nothing is broken by this. The blocked request is remarketing only;
    // analytics collection is unaffected, and the pixel is the one Google fires
    // whether or not you run ads.
    //
    // It is NOT fixed by adding domains here. There are roughly 200 Google
    // ccTLDs and enumerating them would trade a harmless console line for a
    // permanently stale allowlist. The real fix is upstream: turn off Google
    // Signals / ads personalisation in the GA4 property if remarketing is not
    // being used, and the pixel stops firing at source.
    'https://*.googletagmanager.com',
    'https://*.google-analytics.com',
    'https://*.g.doubleclick.net',
    'https://*.google.com',
  ].join(' '),
  [
    "connect-src 'self'",
    // Dev-only HMR websocket + dev server.
    ...(isDev ? ['ws://localhost:*', 'http://localhost:*'] : []),
    // Google Maps JS API: tile/style/places XHR requests + telemetry.
    'https://*.googleapis.com',
    'https://*.gstatic.com',
    'https://*.digitaloceanspaces.com',
    'https://*.r2.dev',
    // Cloudflare Turnstile CAPTCHA makes verification requests to challenges.cloudflare.com.
    'https://challenges.cloudflare.com',
    ...(r2PublicOrigin ? [r2PublicOrigin] : []),
    // Google Tag Manager / Analytics: container config fetch + event/pixel sends.
    'https://*.googletagmanager.com',
    'https://*.google-analytics.com',
    'https://*.analytics.google.com',
    'https://*.g.doubleclick.net',
    'https://*.google.com',
  ].join(' '),
  // Google Maps' vector renderer creates its tile/shader worker from a blob URL.
  "worker-src 'self' blob:",
  // Cloudflare Turnstile renders its challenge in a sandboxed iframe. GTM's
  // Preview/debug banner also needs an iframe, but only in Preview mode, so it
  // is dev-gated the same way 'unsafe-eval' is rather than shipped to prod.
  //
  // youtube.com was allowed here briefly on 2026-08-11 for a sidebar video
  // embed (components/clinics/ClinicSidebarMedia), removed the same day along
  // with that component. Re-add it if that feature comes back — see
  // docs/DECISIONS.md, without it the iframe silently drops with no console
  // error a page script can see, which is how it shipped broken the first time.
  `frame-src 'self' https://challenges.cloudflare.com${isDev ? ' https://www.googletagmanager.com' : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // No <object>/<embed>/<applet>. Legacy plugin embedding is a classic XSS and
  // clickjacking vector and this site has no use for it. Zero-risk tightening.
  "object-src 'none'",
].join('; ')

/**
 * WHY `'unsafe-inline'` IS STILL IN script-src, DELIBERATELY.
 *
 * The standard fix is a per-request nonce: generate one in middleware, stamp it
 * on every inline <script>, and drop 'unsafe-inline'. That does not work on
 * this site, and forcing it would cause a much larger problem than it solves.
 *
 * A nonce is per-REQUEST by definition. To stamp it on the 19 JSON-LD blocks
 * across the app, each of those Server Components must read `headers()`. In the
 * App Router, calling `headers()` opts the route into DYNAMIC rendering. Those
 * blocks live on the clinic, guide, news, provider and city pages, which are
 * exactly the pages served by ISR (`export const revalidate = 300`) and
 * pre-rendered via `generateStaticParams`.
 *
 * So adopting nonces would convert essentially every public page from cached
 * ISR to per-request server rendering. Every visit would hit Postgres through
 * a pool capped at 4. That is the precise failure mode the rest of this work
 * exists to prevent, traded for a CSP improvement.
 *
 * Hash-based CSP is not an alternative either: Next.js emits its own inline
 * hydration bootstrap whose contents change per page and per build, so the
 * hash set cannot be known ahead of time.
 *
 * The residual risk is mitigated in depth: React escapes by default, all
 * JSON-LD is serialized with `JSON.stringify(...).replace(/</g, '\\u003c')`,
 * rich text is sanitized, `object-src`, `base-uri`, `form-action` and
 * `frame-ancestors` are all locked down, and inputs are Zod-validated.
 *
 * To revisit with real data, set CSP_REPORT_ONLY=true. That ships an additional
 * Content-Security-Policy-Report-Only header carrying the strict policy while
 * the permissive one stays enforced, so violations are reported to
 * /api/csp-report without anything breaking.
 */
// `.replace` with a string pattern replaces only the FIRST match, which is the
// one in script-src (it precedes style-src in the array above). style-src keeps
// its 'unsafe-inline' on purpose: Tailwind and next-themes both set inline
// styles, and inline CSS is a far weaker vector than inline script.
const strictCspReportOnly = csp
  .replace(" 'unsafe-inline'", '')
  .concat('; report-uri /api/csp-report')

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  // Opt-in measurement only. Enforced policy above is unchanged; this one just
  // reports what a stricter script-src would have blocked. See the note above
  // strictCspReportOnly.
  ...(process.env.CSP_REPORT_ONLY === 'true'
    ? [{ key: 'Content-Security-Policy-Report-Only', value: strictCspReportOnly }]
    : []),
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(self), interest-cohort=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  // Severs the window.opener relationship with cross-origin pages, so a page
  // we link to cannot reach back into this one. `-allow-popups` (rather than a
  // bare `same-origin`) is deliberate: it keeps windows WE open working
  // normally, which leaves room for a future OAuth/SSO popup or a payment
  // provider window without silently breaking it. There are no such popups
  // today; this is the non-breaking variant by choice.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  // Blocks unrelated origins from embedding our responses as no-cors
  // subresources. `same-site` rather than `same-origin` so any
  // *.injector.world subdomain (e.g. a future media.injector.world) can still
  // load assets from the app. Note this does not affect social/OG scrapers or
  // feed readers: CORP is enforced by browsers on subresource loads only,
  // not on server-side fetches.
  { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No `x-powered-by: Next.js` on every response (2026-09-25): it only tells a
  // scanner which framework to try. docs/FIX-ALL-PLAN-2026-09-24.md 1.7.
  poweredByHeader: false,
  images: {
    // EXACT hosts only, never a wildcard over a shared host (2026-10-05).
    // /_next/image downloads and decodes whatever an allowed host serves, for
    // any anonymous caller. `*.digitaloceanspaces.com` and `**.r2.dev` let
    // anyone who opens a Spaces/R2 bucket feed the optimizer their own file:
    // an oversized image (GHSA-9g9p-9gw9-jx7f, out of memory) or a crafted AVIF
    // (GHSA-2xp9-vwfh-vxw4, remote code execution through libheif). This list
    // is every host the staging DB's image columns actually use, plus our own.
    // Adding a host: make it one exact hostname you control or trust.
    remotePatterns: [
      // Our Spaces bucket: CDN host (clinic photos, guide/news covers) and the
      // origin host (Payload uploads, while R2_PUBLIC_URL points there).
      { protocol: 'https', hostname: 'iw-media.sfo3.cdn.digitaloceanspaces.com' },
      { protocol: 'https', hostname: 'iw-media.sfo3.digitaloceanspaces.com' },
      { protocol: 'https', hostname: 'injector.world' },
      // Demo/seed images still referenced by authors, medical reviewers,
      // locations and photos rows.
      { protocol: 'https', hostname: 'picsum.photos' },
      { protocol: 'https', hostname: 'i.pravatar.cc' },
      // Whatever host R2_PUBLIC_URL names, so moving media to another public
      // host stays an env-only change.
      ...(r2PublicHostname ? [{ protocol: 'https', hostname: r2PublicHostname }] : []),
    ],
  },
  experimental: {
    reactCompiler: false,
    // Force static page generation onto a single worker. Each build worker opens
    // its own DB connection pool; multiple workers exhausted the DO dev-tier
    // Postgres connection limit (error 53300) mid-build. One worker = one pool
    // (max 4), well under the limit, while still giving Payload enough concurrent
    // connections per page to avoid a pool deadlock. Build is slightly slower; the
    // page set is small so the cost is negligible.
    cpus: 1,
    // Tree-shake the Phosphor icon barrel so only used icons ship to the client.
    optimizePackageImports: ['@phosphor-icons/react'],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },
  // /favicon.ico was a 404 on every host (2026-09-25). Browsers and crawlers
  // still ask for it by that name regardless of the <link rel="icon">, so it
  // serves the same app/icon.png. Browsers read PNG bytes under an .ico name.
  async rewrites() {
    return [{ source: '/favicon.ico', destination: '/icon.png' }]
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
