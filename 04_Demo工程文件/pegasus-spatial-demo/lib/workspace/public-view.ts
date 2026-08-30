import { isInternalWorkspacePath } from './path-policy'

export function userVisibleWorkspaceRecord<T>(
  record: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!record) return undefined
  return Object.fromEntries(
    Object.entries(record).filter(([path]) => !isInternalWorkspacePath(path)),
  )
}

/** Remove agent-only files from an object that is about to cross a user API. */
export function hideInternalWorkspaceState(value: Record<string, unknown>): void {
  const output = value.output
  if (!output || typeof output !== 'object' || Array.isArray(output)) return
  const outputRecord = output as Record<string, unknown>
  outputRecord.files = userVisibleWorkspaceRecord(
    outputRecord.files as Record<string, unknown> | undefined,
  )
  outputRecord.manifest = userVisibleWorkspaceRecord(
    outputRecord.manifest as Record<string, unknown> | undefined,
  )
}
