import { loadProjectEnv } from './load-project-env'

async function main(): Promise<void> {
  // llm-config freezes credentials at module evaluation time, so match the
  // Next.js environment before importing any provider or registry module.
  loadProjectEnv()
  const {
    createDefaultRepairDurableCompactionDependencies,
    executeRepairDurableCompactionCommand,
    parseRepairDurableCompactionArgs,
    REPAIR_DURABLE_COMPACTION_HELP,
  } = await import('./repair-durable-compaction-operator')
  const command = parseRepairDurableCompactionArgs(process.argv.slice(2))
  if (command.mode === 'help') {
    console.log(REPAIR_DURABLE_COMPACTION_HELP)
    return
  }
  const dependencies = await createDefaultRepairDurableCompactionDependencies()
  const result = await executeRepairDurableCompactionCommand(command, dependencies)
  console.log(JSON.stringify(result, null, 2))
}

void main().then(async () => {
  const mongoose = (await import('mongoose')).default
  await mongoose.disconnect()
}).catch(async error => {
  console.error(error instanceof Error ? error.message : 'Unknown operator repair failure.')
  const mongoose = (await import('mongoose')).default
  await mongoose.disconnect().catch(() => undefined)
  process.exitCode = 1
})
