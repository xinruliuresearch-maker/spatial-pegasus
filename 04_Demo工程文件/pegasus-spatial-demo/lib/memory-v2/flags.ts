function enabled(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? '')
}
export const memoryV2Flags = {
  extraction: () => enabled('MEMORY_V2_EXTRACTION'),
  profileInjection: () => enabled('MEMORY_V2_PROFILE_INJECTION'),
  historyInjection: () => enabled('MEMORY_V2_HISTORY_INJECTION'),
  recallTool: () => enabled('MEMORY_V2_RECALL_TOOL'),
}
