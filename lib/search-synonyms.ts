/**
 * Search-only vocabulary (2026-09-28, Phase A of the search spelling work).
 *
 * Deliberately separate from the importer's alias maps in lib/import/helpers.ts:
 * those decide how CSV rows are tagged, and a search synonym must never change
 * what a clinic is tagged with. Everything here is read by lib/search-intent.ts
 * ONLY after the exact dictionary match found nothing, so a query that resolves
 * today resolves identically.
 *
 * Every target slug is checked against the live Services / Brands rows when the
 * lookups are built, so a synonym for a service that does not exist is simply
 * ignored rather than producing an empty search.
 *
 * Phrases are matched after lowercasing, dropping spaces/hyphens/punctuation and
 * a trailing plural "s", so "lip injections", "lip-injection" and
 * "lipinjections" are all the same entry. Keep entries unambiguous: a phrase
 * that could reasonably mean two different treatments does not belong here
 * ("bbl" is both a laser photofacial and a Brazilian butt lift, so it is out).
 */

/** Consumer phrase -> service slug. */
export const SERVICE_SYNONYMS: Record<string, string> = {
  // Lips
  'lip injection': 'lip-filler',
  'lip augmentation': 'lip-filler',
  'lip enhancement': 'lip-filler',
  'lip plumping': 'lip-filler',
  'lip flip botox': 'lip-flip',
  // Cheeks, chin, jaw, temples
  'cheek injection': 'cheek-filler',
  'cheek augmentation': 'cheek-filler',
  'chin injection': 'chin-filler',
  'chin augmentation': 'chin-filler',
  'jaw filler': 'jawline-filler',
  'jawline injection': 'jawline-filler',
  'jawline contouring': 'jawline-filler',
  'temple injection': 'temple-filler',
  // Fillers in general
  filler: 'dermal-filler',
  'facial filler': 'dermal-filler',
  'face filler': 'dermal-filler',
  'hand filler': 'hand-treatment',
  'hand rejuvenation': 'hand-treatment',
  'facial harmonization': 'facial-balancing',
  'face balancing': 'facial-balancing',
  // Neurotoxin areas
  'jaw botox': 'masseter-botox',
  'masseter injection': 'masseter-botox',
  'jaw slimming': 'masseter-botox',
  'tmj botox': 'masseter-botox',
  '11 lines': 'frown-lines',
  'eleven lines': 'frown-lines',
  'glabellar lines': 'frown-lines',
  'brow botox': 'brow-lift',
  'botox brow lift': 'brow-lift',
  'neck botox': 'neck-bands',
  'platysmal bands': 'neck-bands',
  'nefertiti lift': 'neck-bands',
  // Skin
  acne: 'acne-treatment',
  'skin peel': 'chemical-peel',
  peel: 'chemical-peel',
  'collagen induction therapy': 'microneedling',
  'platelet rich plasma': 'prp',
  'vampire facial': 'prp',
  ipl: 'photofacial',
  'ipl photofacial': 'photofacial',
  hyperpigmentation: 'pigmentation-treatment',
  melasma: 'pigmentation-treatment',
  'dark spots': 'pigmentation-treatment',
  'sun spots': 'pigmentation-treatment',
  'laser resurfacing': 'skin-resurfacing',
  'co2 laser': 'skin-resurfacing',
  fraxel: 'skin-resurfacing',
  'spider vein': 'spider-vein-treatment',
  sclerotherapy: 'spider-vein-treatment',
  'laser tattoo removal': 'tattoo-removal',
  'hair removal': 'laser-hair-removal',
  'laser hair': 'laser-hair-removal',
  'hair loss': 'hair-restoration',
  'hair loss treatment': 'hair-restoration',
  'hair regrowth': 'hair-restoration',
  microblading: 'permanent-makeup',
  'eyebrow tattoo': 'permanent-makeup',
  'lip blush': 'permanent-makeup',
  'lash lift': 'eyelash-treatment',
  'eyelash growth': 'eyelash-treatment',
  'pdo thread': 'thread-lift',
  'pdo thread lift': 'thread-lift',
  // Body
  cellulite: 'cellulite-reduction',
  'love handle': 'flank-love-handles',
  'bra fat': 'back-includes-bra-fat',
  'back fat': 'back-includes-bra-fat',
  'double chin': 'under-the-jaw-submandibular-fat',
  'body sculpting': 'body-contouring',
  'fat reduction': 'body-contouring',
  'vaginal tightening': 'vaginal-rejuvenation',
  // Wellness
  'iv drip': 'iv-therapy',
  'iv hydration': 'iv-therapy',
  'iv infusion': 'iv-therapy',
  'b12 injection': 'vitamin-injections',
  'b12 shot': 'vitamin-injections',
  'vitamin shot': 'vitamin-injections',
  // No weight-loss / GLP-1 synonyms yet: very few clinics carry the Weight
  // Management tag (the GLP-1 import is paused), so mapping "weight loss" to it
  // loses the clinics that only have it in their NAME. Add them once that data
  // is in.
}

/** Consumer phrase -> brand slug. Product-line names map to their brand. */
export const BRAND_SYNONYMS: Record<string, string> = {
  'anti wrinkle injection': 'botox',
  'wrinkle relaxer': 'botox',
  'baby botox': 'botox',
  voluma: 'juvederm',
  volbella: 'juvederm',
  vollure: 'juvederm',
  volux: 'juvederm',
  kysse: 'restylane-kysse',
  'fat freezing': 'coolsculpting',
  cryolipolysis: 'coolsculpting',
  coolsculpt: 'coolsculpting',
  emsculpt: 'emsculpt-neo',
  thermage: 'thermage-flx',
  ulthera: 'ultherapy',
  rha: 'teoxane-rha',
  teoxane: 'teoxane-rha',
  'zo skin': 'zo-skin-health',
  skinbetter: 'skinbetter-science',
  'belotero balance': 'belotero',
}

/**
 * Words that describe the SEARCH rather than the clinic ("best", "near me",
 * "cost", "injections"). They are dropped from the leftover name text, but only
 * when the query already named a treatment, brand, place or ZIP: on their own
 * they may be part of a clinic's name and are then searched as typed.
 *
 * Why it matters: leftover words are matched against clinic NAMES with AND, so
 * "best botox houston" required a Houston botox clinic with "best" in its name
 * and returned 0 (measured on staging 2026-09-28).
 */
export const QUERY_NOISE = new Set([
  'best', 'top', 'rated', 'good', 'great', 'cheap', 'cheapest', 'affordable', 'discount', 'deal', 'deals',
  'special', 'specials', 'cost', 'costs', 'price', 'prices', 'pricing', 'how', 'much',
  'injection', 'injections', 'injectable', 'injectables', 'injector', 'injectors',
  'treatment', 'treatments', 'procedure', 'procedures', 'service', 'services',
  // Not "med", "spa" or "medspa": "med spa houston" asks for med spas, and
  // dropping them would widen it to every Houston clinic.
  'clinic', 'clinics', 'center', 'centre', 'office', 'doctor', 'doctors',
  'specialist', 'specialists', 'provider', 'providers', 'appointment', 'appointments', 'consultation',
  'in', 'at', 'for', 'around', 'the', 'a', 'an', 'of', 'to', 'and', 'with', 'my', 'by', 'on',
  'open', 'now', 'today', 'near', 'nearby', 'me', 'closest',
  // Question phrasing: "how much does botox cost in houston".
  'does', 'is', 'are', 'what', 'where', 'which', 'can', 'i', 'get', 'find', 'looking', 'want', 'need',
])

/**
 * "near me" style phrases. When one is present and the query names no place,
 * the search is centred on the visitor's own ZIP (when the caller can supply
 * it). Matched on whole tokens after lowercasing.
 */
export const NEAR_ME_PHRASES = [['near', 'me'], ['near', 'by'], ['nearby'], ['close', 'to', 'me'], ['closest']]
