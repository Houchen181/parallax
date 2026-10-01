import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { plainSeal } from '../server/system'
import { KeyStore } from './backend'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'parallax-keys-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('KeyStore', () => {
  it('keeps keys that another process saved to the same file', async () => {
    const file = join(dir, 'api-keys.json')
    // The local web version and the plugin each hold their own KeyStore on one file.
    const web = new KeyStore(file, plainSeal.seal, plainSeal.unseal)
    const plugin = new KeyStore(file, plainSeal.seal, plainSeal.unseal)
    await web.load()
    await plugin.load()

    await web.set('openai', 'key-one', 'https://api.openai.com/v1')
    await plugin.set('anthropic', 'key-two', 'https://api.anthropic.com')
    await Promise.all([web.set('groq', 'key-three', 'https://api.groq.com/openai/v1'), web.set('xai', 'key-four', 'https://api.x.ai/v1')])

    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(Object.keys(saved).sort()).toEqual(['anthropic', 'groq', 'openai', 'xai'])

    await plugin.refresh()
    expect(plugin.keyFor('openai', new URL('https://api.openai.com/v1/models'))).toBe('key-one')
    expect(() => plugin.keyFor('openai', new URL('https://evil.example/v1'))).toThrow(/locked to https:\/\/api.openai.com/)

    await plugin.remove('openai')
    await web.refresh()
    expect(web.list().map((k) => k.providerId).sort()).toEqual(['anthropic', 'groq', 'xai'])
  })
})
