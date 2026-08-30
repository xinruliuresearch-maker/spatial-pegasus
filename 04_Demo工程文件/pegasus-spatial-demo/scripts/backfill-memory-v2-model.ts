import { connectDB } from '../lib/db/mongodb'
import { ModelConfig } from '../lib/db/model-config-models'

async function main() {
  await connectDB()
  const result = await ModelConfig.updateOne(
    { config_key: 'main' },
    {
      $set: {
        'aliases.tool_memory_fast': { realModel: 'Gemini-3-flash', keyChannel: 'tools' },
        'toolSelection.memory': { free: 'tool_memory_fast', pro: 'tool_memory_fast', team: 'tool_memory_fast' },
      },
    },
    { upsert: false }
  )
  console.log(`[memory-v2] model config matched=${result.matchedCount} modified=${result.modifiedCount}`)
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error)
  process.exit(1)
})
