/** Compile the deliberately small glob dialect used by Workspace tools. */
export function workspaceGlobToRegex(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += '\\.^$+{}()|[]'.includes(char) ? '\\' + char : char
  }
  return new RegExp(source + '$')
}
