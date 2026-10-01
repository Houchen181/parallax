// Text fixes applied before rendering model output as Markdown.

const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g

/**
 * Converts \[...\] and \(...\) (common in model output) to the $$ / $ syntax
 * that remark-math understands, and escapes dollar signs that are clearly
 * prices so "$5 and $10" is not read as math. Code is left untouched.
 */
export function prepareMarkdown(source: string): string {
  return source
    .split(CODE)
    .map((part, index) => {
      if (index % 2 === 1) return part
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, math: string) => `$${math.trim()}$`)
        .replace(/(^|[\s(])\$(?=\d[\d,.]*(?:\s|$|[kKmMbB%),.;:!?]))/g, (_, before: string) => `${before}\\$`)
    })
    .join('')
}
