import { describe, expect, it } from 'vitest'
import { prepareMarkdown } from './markdown'

describe('prepareMarkdown', () => {
  it('converts LaTeX delimiters to remark-math syntax', () => {
    expect(prepareMarkdown('Energy \\(E = mc^2\\).')).toBe('Energy $E = mc^2$.')
    expect(prepareMarkdown('\\[a^2 + b^2 = c^2\\]')).toBe('\n$$\na^2 + b^2 = c^2\n$$\n')
  })

  it('escapes prices so they are not read as math', () => {
    expect(prepareMarkdown('It costs $5 or $10.50 per month')).toBe('It costs \\$5 or \\$10.50 per month')
  })

  it('leaves real inline math alone', () => {
    expect(prepareMarkdown('Let $2x + 1$ be odd')).toBe('Let $2x + 1$ be odd')
  })

  it('does not touch code', () => {
    const code = '```\nprice = "$5" \\(x\\)\n```'
    expect(prepareMarkdown(code)).toBe(code)
    expect(prepareMarkdown('Run `echo $5`')).toBe('Run `echo $5`')
  })
})
