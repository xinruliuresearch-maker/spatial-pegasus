import { ToolResult } from '../types'
import { WorkspaceInstance } from '../workspace/types'
import {
  canonicalWorkspaceWritePath,
  isManagedLiteratureArtifactPath,
} from '../workspace/path-policy'

interface EditInput {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export async function executeEdit(
  input: EditInput,
  workspace: WorkspaceInstance
): Promise<ToolResult> {
  const { file_path, old_string, new_string, replace_all = false } = input

  if (typeof file_path !== 'string' || !file_path.trim()) {
    return { content: 'file_path cannot be empty', is_error: true }
  }
  if (typeof old_string !== 'string' || !old_string) {
    return { content: 'old_string cannot be empty', is_error: true }
  }
  if (typeof new_string !== 'string') {
    return { content: 'new_string must be a string', is_error: true }
  }
  if (typeof replace_all !== 'boolean') {
    return { content: 'replace_all must be a boolean', is_error: true }
  }

  if (isManagedLiteratureArtifactPath(file_path)) {
    return {
      content: 'Literature retrieval and parser artifacts are read-only; write analysis to notes/ or analysis/ instead',
      is_error: true,
    }
  }

  const content = await workspace.read(file_path)
  if (content === null) {
    return { content: `File not found: ${file_path}`, is_error: true }
  }

  if (old_string === new_string) {
    return { content: 'old_string and new_string are identical', is_error: true }
  }

  const occurrences = content.split(old_string).length - 1
  if (occurrences === 0) {
    return {
      content: `old_string not found in ${file_path}. Make sure it matches exactly.`,
      is_error: true,
    }
  }
  if (!replace_all && occurrences > 1) {
    return {
      content: `old_string found ${occurrences} times in ${file_path}. Provide more context to make it unique.`,
      is_error: true,
    }
  }

  const newContent = replace_all
    ? content.split(old_string).join(new_string)
    : content.replace(old_string, new_string)
  try {
    const actualPath = canonicalWorkspaceWritePath(file_path)
    await workspace.write(file_path, newContent)
    const replacementCount = replace_all ? occurrences : 1
    return {
      content: `Successfully edited ${actualPath} (${replacementCount} replacement${replacementCount === 1 ? '' : 's'})`,
      updatedContent: newContent,
    }
  } catch (err) {
    return {
      content: `Failed to edit ${file_path}: ${(err as Error).message}`,
      is_error: true,
    }
  }
}
