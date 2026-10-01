import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { Element, ElementContent } from 'hast'
import { Check, Copy } from 'lucide-react'
import { prepareMarkdown } from '../lib/markdown'
import { openExternal } from '../lib/platform'
import { cn } from './ui'

function textOf(node: ElementContent | Element): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(textOf).join('')
  return ''
}

export function CopyButton({ text, className, label = 'Copy' }: { text: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        })
      }}
      className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-hover hover:text-fg', className)}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : null}
    </button>
  )
}

function CodeBlock({ node, children }: { node?: Element; children?: ReactNode }) {
  const code = node?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code')
  const classes = (code?.properties?.className as string[] | undefined) ?? []
  const language = classes.find((c) => c.startsWith('language-'))?.slice('language-'.length)
  return (
    <div className="not-prose my-3 overflow-hidden rounded-xl border border-line bg-code">
      <div className="flex items-center justify-between border-b border-line px-3 py-1 text-xs text-muted">
        <span className="font-mono">{language ?? 'text'}</span>
        <CopyButton text={code ? textOf(code).replace(/\n$/, '') : ''} label="Copy code" />
      </div>
      <pre>{children}</pre>
    </div>
  )
}

const components: Components = {
  pre: ({ node, children }) => <CodeBlock node={node}>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        if (href && /^https?:/i.test(href)) {
          event.preventDefault()
          openExternal(href)
        }
      }}
    >
      {children}
    </a>
  ),
  // Remote images in model output could leak data to third parties; show a link instead.
  img: ({ src, alt }) =>
    typeof src === 'string' && /^https?:/i.test(src) ? (
      <a
        href={src}
        onClick={(event) => {
          event.preventDefault()
          openExternal(src)
        }}
      >
        [image: {alt || src}]
      </a>
    ) : (
      <span>[image: {alt}]</span>
    ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
}

const remarkPlugins: Options['remarkPlugins'] = [remarkGfm, remarkMath]
const rehypePlugins: Options['rehypePlugins'] = [
  [rehypeKatex, { throwOnError: false, strict: 'ignore' }],
  [rehypeHighlight, { detect: false }],
]

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('markdown prose prose-neutral max-w-none dark:prose-invert', className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {prepareMarkdown(text)}
      </ReactMarkdown>
    </div>
  )
})
