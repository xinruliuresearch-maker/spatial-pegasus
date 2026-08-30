import { ToolResult } from '../types'
import { WorkspaceInstance } from '../workspace/types'
import {
  canonicalWorkspaceWritePath,
  isManagedLiteratureArtifactPath,
} from '../workspace/path-policy'

interface WriteInput {
  file_path: string
  content: string
}

export async function executeWrite(
  input: WriteInput,
  workspace: WorkspaceInstance
): Promise<ToolResult> {
  if (typeof input.file_path !== 'string' || !input.file_path.trim()) {
    return { content: 'file_path cannot be empty', is_error: true }
  }
  if (typeof input.content !== 'string') {
    return { content: 'content must be a string', is_error: true }
  }
  try {
    const actualPath = canonicalWorkspaceWritePath(input.file_path)
    if (isManagedLiteratureArtifactPath(actualPath)) {
      throw new Error('Literature retrieval and parser artifacts are read-only; write analysis to notes/ or analysis/ instead')
    }
    await workspace.write(input.file_path, input.content)
    return { content: `Successfully wrote to ${actualPath}` }
  } catch (err) {
    return {
      content: `Failed to write ${input.file_path}: ${(err as Error).message}`,
      is_error: true,
    }
  }
}
