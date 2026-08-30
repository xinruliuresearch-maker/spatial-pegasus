/** Remove workflow-only suffixes while keeping meaningful scene variants. */
export function conciseSceneDisplayName(title: string): string {
  const concise = title
    .trim()
    .replace(/\s*[（(](?:组装预览|自动预览|生成预览|assembled preview|preview)[）)]\s*$/i, '')
    .replace(/\s+(?:scene|场景模型)\s*$/i, '')
    .trim()
  return concise || '未命名场景'
}
