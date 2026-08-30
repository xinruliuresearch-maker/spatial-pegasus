type HastNode = HastElement | HastText | HastParent | { type: string }

interface HastParent {
  type: string
  children: HastNode[]
}

interface HastElement extends HastParent {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
}

interface HastText {
  type: 'text'
  value: string
}

export const SCIENTIFIC_FIGURE_CLUSTER_CLASS = 'scientific-figure-cluster'
export const SCIENTIFIC_FIGURE_IMAGE_CLASS = 'scientific-figure-image'

const MAX_CLUSTER_SIZE = 7
const MALFORMED_PLACEHOLDER_TAIL = /^ge\/dt=\d{4}-\d{2}-\d{2}\/ht=\d{1,2}\/\/[a-f0-9]{64}\.(?:jpe?g|png|webp)\)$/

function isParent(node: HastNode): node is HastParent {
  return Array.isArray((node as HastParent).children)
}

function isElement(node: HastNode, tagName?: string): node is HastElement {
  return node.type === 'element'
    && (!tagName || (node as HastElement).tagName === tagName)
}

function isWhitespace(node: HastNode): node is HastText {
  return node.type === 'text' && !((node as HastText).value.trim())
}

function classNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : []
}

function imageOnlyParagraph(node: HastNode): HastElement[] | null {
  if (!isElement(node, 'p')) return null
  const meaningful = node.children.filter(child => !isWhitespace(child))
  if (meaningful.length === 0 || !meaningful.every(child => isElement(child, 'img'))) return null
  return meaningful as HastElement[]
}

/**
 * The provider occasionally emits one exact corrupt token: an empty image with
 * `src="image"`, followed by the tail of a dated image path. It is neither a
 * caption nor a recoverable resource reference. Keep this predicate deliberately
 * narrow so similar prose and valid image references remain visible.
 */
export function isExactMalformedScientificImagePlaceholder(node: HastNode): boolean {
  if (!isElement(node, 'p')) return false
  const meaningful = node.children.filter(child => !isWhitespace(child))
  if (meaningful.length !== 2) return false
  const [image, tail] = meaningful
  if (!isElement(image, 'img') || tail.type !== 'text') return false
  const properties = image.properties ?? {}
  return properties.src === 'image'
    && (properties.alt === '' || properties.alt === undefined)
    && properties.title === undefined
    && MALFORMED_PLACEHOLDER_TAIL.test((tail as HastText).value)
}

function markClusterImage(image: HastElement, index: number): HastElement {
  const properties = image.properties ?? {}
  return {
    ...image,
    properties: {
      ...properties,
      className: [...classNames(properties.className), SCIENTIFIC_FIGURE_IMAGE_CLASS],
      dataScientificFigureIndex: String(index + 1),
    },
  }
}

function cluster(images: HastElement[]): HastElement {
  return {
    type: 'element',
    tagName: 'figure',
    properties: {
      className: [SCIENTIFIC_FIGURE_CLUSTER_CLASS],
      dataScientificFigureCount: String(images.length),
    },
    children: images.map(markClusterImage),
  }
}

function transformParent(parent: HastParent): void {
  const clean = parent.children.filter(child => !isExactMalformedScientificImagePlaceholder(child))
  const grouped: HastNode[] = []
  let index = 0

  while (index < clean.length) {
    const firstImages = imageOnlyParagraph(clean[index])
    if (!firstImages) {
      grouped.push(clean[index])
      index += 1
      continue
    }

    const images = [...firstImages]
    let cursor = index + 1
    while (cursor < clean.length) {
      while (cursor < clean.length && isWhitespace(clean[cursor])) cursor += 1
      const nextImages = cursor < clean.length ? imageOnlyParagraph(clean[cursor]) : null
      if (!nextImages) break
      images.push(...nextImages)
      cursor += 1
    }

    for (let offset = 0; offset < images.length; offset += MAX_CLUSTER_SIZE) {
      grouped.push(cluster(images.slice(offset, offset + MAX_CLUSTER_SIZE)))
    }
    index = cursor
  }

  parent.children = grouped
}

/** Run after rehype-sanitize: this only groups already-sanitized image nodes. */
export function rehypeScientificFigures() {
  return (tree: HastNode) => {
    // Only the document flow is eligible. Images inside lists, quotations,
    // tables, links, or publisher-authored figures keep their original
    // semantics and can never be pulled into a neighbouring plate.
    if (isParent(tree)) transformParent(tree)
  }
}
