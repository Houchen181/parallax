import type { ProviderKind } from '../types'
import { anthropicAdapter } from './anthropic'
import { demoAdapter } from './demo'
import { openaiAdapter } from './openai'
import type { ProviderAdapter } from './types'

export function adapterFor(kind: ProviderKind): ProviderAdapter {
  switch (kind) {
    case 'anthropic':
      return anthropicAdapter
    case 'openai':
      return openaiAdapter
    case 'demo':
      return demoAdapter
  }
}
