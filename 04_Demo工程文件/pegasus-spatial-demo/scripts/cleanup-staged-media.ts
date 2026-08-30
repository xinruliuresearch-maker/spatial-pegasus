import mongoose from 'mongoose'
import { cleanupExpiredStagedAssets } from '../lib/media/storage'
import { loadProjectEnv } from './load-project-env'

loadProjectEnv()

async function main() {
  if (!process.argv.includes('--apply')) throw new Error('Add --apply to delete staged assets older than 24 hours')
  const count = await cleanupExpiredStagedAssets()
  console.log(`[media:staged-cleanup] deleted ${count} expired staged asset(s)`)
}

main()
  .catch(error => { console.error('[media:staged-cleanup] failed:', error); process.exitCode = 1 })
  .finally(async () => { await mongoose.disconnect() })
