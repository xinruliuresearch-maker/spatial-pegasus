// Map a mutating tool call to the workspace artifact it changes. Read-only
// tools return null and therefore never put a tab into an editing state.

function normalizePath(path: string): string {
  return path.replace(/^\/workspace\//, '').replace(/^workspace\//, '').replace(/^\//, '')
}

export function extractTargetPath(tool: string, input: Record<string, unknown>): string | null {
  if (tool === 'Write' || tool === 'Edit') {
    const filePath = input.file_path
    return typeof filePath === 'string' && filePath.length > 0
      ? normalizePath(filePath)
      : null
  }
  if (tool === 'GenerateImage') {
    const outputPath = input.output_path
    return typeof outputPath === 'string' && outputPath.length > 0
      ? normalizePath(outputPath)
      : null
  }
  if (tool === 'CreateObject3D' || tool === 'CreateWorld3D') {
    const prefix = input.output_path_prefix
    if (typeof prefix !== 'string' || prefix.length === 0) return null
    const normalized = normalizePath(prefix).replace(/\/$/, '')
    return `${normalized}/${tool === 'CreateObject3D' ? 'model.glb' : 'manifest.json'}`
  }
  return null
}
