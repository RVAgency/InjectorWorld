/**
 * Import news/guide JSON files using the content importer.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/import-content.ts <file1.json> [file2.json] ...
 *
 * Example:
 *   npx tsx --env-file=.env.local scripts/import-content.ts data/samples/news.sample.json
 */

import { getPayload } from 'payload'
import fs from 'fs'
import path from 'path'
import config from '../payload.config'
import { runContentImport } from '../lib/import/content-import'

async function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const dryRun = process.argv.includes('--dry-run')

  if (!files.length) {
    console.error('Usage: npx tsx scripts/import-content.ts <file.json> [...]')
    process.exit(1)
  }

  const payload = await getPayload({ config })

  for (const file of files) {
    const abs = path.resolve(file)
    if (!fs.existsSync(abs)) { console.error(`File not found: ${abs}`); continue }

    console.log(`\n===== Importing ${path.basename(abs)} ${dryRun ? '(DRY RUN)' : ''} =====`)
    const raw = fs.readFileSync(abs, 'utf8')
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      console.error(`Invalid JSON: ${abs}`); continue
    }

    const report = await runContentImport(payload, parsed, { dryRun, batch: path.basename(abs, '.json') })
    console.log(`Collection: ${report.collection}`)
    console.log(`  Created : ${report.items.created}`)
    console.log(`  Updated : ${report.items.updated}`)
    console.log(`  Skipped : ${report.items.skipped}`)
    if (report.alerts.length) {
      console.log(`  Alerts  : ${report.alerts.length}`)
      for (const a of report.alerts.slice(0, 20)) console.log(`    [${a.severity}] ${a.message}`)
    }
  }

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
