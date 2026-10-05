/**
 * CSV bulk import for clinics, providers, reviews, photos, and Q&A.
 *
 * Reads CSVs that match data/scraper-brief.md schemas, upserts by business id
 * (clinicId / providerId / reviewId / photoId / qaId), validates relationships,
 * and writes any problems to the DataAlerts collection (visible in /admin).
 *
 * Usage:
 *   npm run import                                  # data/samples/*.sample.csv
 *   npm run import -- --dir ./data/batch            # clinics.csv / providers.csv / reviews.csv / photos.csv / qa.csv
 *   npm run import -- --dir ./data/batch --dry-run  # preview counts + alerts, write nothing
 *   npm run import -- --combined ./data/all.csv      # one file with a record_type column
 *   npm run import -- --dir ./data/batch --batch=batch-2026-10
 *
 * Safe to re-run: existing records are updated, not duplicated.
 */
import { getPayload } from 'payload'
import fs from 'fs'
import path from 'path'
import config from '../payload.config'
import { parseCsv, splitByRecordType } from '../lib/import/csv'
import { runImport } from '../lib/import/import-data'
import type { Row } from '../lib/import/helpers'

function readIfExists(p: string): string | null {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  const pre = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(pre))
  return hit ? hit.slice(pre.length) : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function main() {
  const dryRun = flag('dry-run')
  const batch = arg('batch')
  const combined = arg('combined')

  let data: { clinics?: Row[]; providers?: Row[]; reviews?: Row[]; photos?: Row[]; qa?: Row[] }

  console.log(`\n===== injector.world data import${dryRun ? ' (DRY RUN)' : ''} =====`)

  if (combined) {
    const text = readIfExists(path.resolve(combined))
    if (!text) { console.error(`Combined file not found: ${combined}`); process.exit(1) }
    const split = splitByRecordType(parseCsv(text))
    console.log(`Combined file: ${combined}`)
    if (Object.keys(split.unknownTypes).length) console.log('Unknown record_type rows skipped:', split.unknownTypes)
    data = {
      clinics: split.clinics.length ? split.clinics : undefined,
      providers: split.providers.length ? split.providers : undefined,
      reviews: split.reviews.length ? split.reviews : undefined,
      photos: split.photos.length ? split.photos : undefined,
      qa: split.qa.length ? split.qa : undefined,
    }
  } else {
    const dirFlag = process.argv.indexOf('--dir')
    const useSamples = dirFlag === -1
    const dir = useSamples ? path.resolve('data/samples') : path.resolve(process.argv[dirFlag + 1])
    const suffix = useSamples ? '.sample.csv' : '.csv'
    console.log(`Source dir: ${dir}  (${useSamples ? 'SAMPLE' : 'REAL'} data)`)

    const clinicsText = readIfExists(path.join(dir, `clinics${suffix}`))
    const providersText = readIfExists(path.join(dir, `providers${suffix}`))
    const reviewsText = readIfExists(path.join(dir, `reviews${suffix}`))
    const photosText = readIfExists(path.join(dir, `photos${suffix}`))
    const qaText = readIfExists(path.join(dir, `qa${suffix}`))

    if (!clinicsText && !providersText && !reviewsText && !photosText && !qaText) {
      console.error(`No CSVs found in ${dir}.`)
      process.exit(1)
    }
    data = {
      clinics: clinicsText ? parseCsv(clinicsText) : undefined,
      providers: providersText ? parseCsv(providersText) : undefined,
      reviews: reviewsText ? parseCsv(reviewsText) : undefined,
      photos: photosText ? parseCsv(photosText) : undefined,
      qa: qaText ? parseCsv(qaText) : undefined,
    }
  }

  const payload = await getPayload({ config })
  const report = await runImport(payload, data, { source: 'import', dryRun, batch, maxReviewsPerClinic: 0 })

  console.log('')
  console.log('Clinics  ', report.clinics)
  console.log('Providers', report.providers)
  console.log('Reviews  ', report.reviews)
  console.log('Photos   ', report.photos)
  console.log('Q&A      ', report.qa)
  console.log(`\nAlerts ${dryRun ? 'that would be raised' : 'raised'}: ${report.alerts.length}`)
  const bySeverity = report.alerts.reduce<Record<string, number>>((acc, a) => {
    acc[a.severity] = (acc[a.severity] ?? 0) + 1
    return acc
  }, {})
  console.log('  by severity:', bySeverity)
  for (const a of report.alerts) console.log(`  [${a.severity}] ${a.type}: ${a.message}`)
  if (dryRun) console.log(`\nDRY RUN: nothing was written. Re-run without --dry-run to commit.`)
  else console.log(`\nAlerts are saved to the DataAlerts collection (/admin → System → Data Alerts).`)
  console.log(`===== import ${dryRun ? 'preview' : 'complete'} =====\n`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
