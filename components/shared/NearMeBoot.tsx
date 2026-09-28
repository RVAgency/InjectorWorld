import { NEAR_ME_RADIUS_LADDER } from '@/lib/merit'

/**
 * Pre-hydration switch for the near-me listings (2026-09-19, founder
 * decision D3).
 *
 * Without this the visitor sees three states: the server-rendered national
 * list, then the skeleton once hydration runs, then the ZIP list. The served
 * HTML has to keep the national list for crawlers (hard rule 6), so the list
 * cannot be removed. It can be hidden before it is ever painted, which is what
 * this does, and it is the only way to satisfy both rules at once.
 *
 * Runs during HTML parse, before the listing markup below it is parsed, so the
 * national list is never painted. Idempotent: setting the attribute twice and
 * registering the timeout twice are both harmless.
 *
 * The timeout is a hard safety net that does not depend on React. If hydration
 * never happens (a bundle 404, a JS error, an old browser) the attribute is
 * removed and the real list appears.
 *
 * It also starts the geo request (2026-09-24, docs/PAGE-SPEED-PLAN-2026-09-24.md
 * TASK 3). Until then useNearMe only asked once React had hydrated, so on a
 * phone the visitor's location was looked up AFTER the JS bundles had
 * downloaded and run, and the hidden list waited for both in sequence. Started
 * here, during HTML parse, the lookup runs while the bundles load. useNearMe
 * picks up the promise from window.__iwNearMeGeo and asks itself only when
 * there is none (a client-side navigation, where this script never runs).
 * Skipped when a saved ZIP exists: that path is synchronous and needs no
 * network. `iw:near-me` is useNearMe's STORAGE_KEY.
 *
 * Round C (same day): with `listUrl` it also starts the page-1 LISTING request
 * the moment a place is known, a saved ZIP straight away or the geo answer when
 * it lands, and parks it on window.__iwNearMeList. The URL is built the way the
 * listing builds its own default near-me request: the ZIP centre (never the IP
 * point), coordinates at 4 decimals (roundForCache), the first rung of
 * NEAR_ME_RADIUS_LADDER and, since 2026-09-28, the ZIP itself (its clinics
 * lead; toServerFilterParams sends it). lib/near-me-prefetch.ts uses the parked answer only
 * when the listing's own URL is identical, so ordering, the ladder and the
 * filters are untouched; a mismatch just means a normal fetch.
 */
export function NearMeBoot({ listUrl }: { listUrl?: string }) {
  // JSON-encoded and `<`-escaped: the slug in it comes from the route, and it
  // lands inside a <script>. Same rule as every JSON-LD block on the site.
  const L = JSON.stringify(listUrl ?? '').replace(/</g, '\\u003c')
  const R = String(NEAR_ME_RADIUS_LADDER[0])
  return (
    <script
      dangerouslySetInnerHTML={{
        __html:
          "try{var d=document.documentElement,w=window;d.setAttribute('data-near-me','pending');" +
          "setTimeout(function(){d.removeAttribute('data-near-me')},2500);" +
          `var L=${L},R=${R};` +
          "function n(v){return typeof v==='number'&&isFinite(v)}" +
          "function f(v){return String(Number(v.toFixed(4)))}" +
          "function list(a,b,z){if(!L||w.__iwNearMeList||!w.fetch)return;var u=L+'&lat='+f(a)+'&lng='+f(b)+'&radius='+R+'&zip='+z;" +
          "w.__iwNearMeList={url:u,p:fetch(u).then(function(r){return r.ok?r.json():null})['catch'](function(){return null})}}" +
          "var s=null;try{s=localStorage.getItem('iw:near-me')}catch(e){}" +
          "if(s){try{var p=JSON.parse(s);if(p&&typeof p.zip==='string'&&/^\\d{5}$/.test(p.zip)&&n(p.lat)&&n(p.lng))list(p.lat,p.lng,p.zip)}catch(e){}}" +
          "else if(!w.__iwNearMeGeo&&w.fetch){w.__iwNearMeGeo=" +
          "fetch('/api/geo/ip?centre=1').then(function(r){return r.ok?r.json():null})" +
          "['catch'](function(){return null});" +
          "w.__iwNearMeGeo.then(function(g){if(g&&n(g.lat)&&n(g.lng)&&typeof g.zip==='string'&&/^\\d{5}$/.test(g.zip)" +
          "&&g.centre&&n(g.centre.lat)&&n(g.centre.lng))list(g.centre.lat,g.centre.lng,g.zip)})}}catch(e){}",
      }}
    />
  )
}
