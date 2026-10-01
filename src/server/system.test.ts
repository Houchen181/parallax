import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adoptLegacyData, legacyDataDir, localDataDir } from './system'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'parallax-system-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('data folder', () => {
  it('honors PARALLAX_DATA_DIR and has no old folder to move then', () => {
    expect(localDataDir({ PARALLAX_DATA_DIR: dir })).toBe(dir)
    expect(legacyDataDir({ PARALLAX_DATA_DIR: dir })).toBeUndefined()
  })

  it('stays out of AppData on Windows', () => {
    const current = localDataDir({})
    if (process.platform === 'win32') {
      expect(current).not.toMatch(/AppData/i)
      expect(legacyDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' })).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'Parallax Local'))
    } else {
      expect(legacyDataDir({})).toBeUndefined()
    }
  })

  it('moves keys and sign-ins from the old folder once', async () => {
    const legacy = join(dir, 'Parallax Local')
    const target = join(dir, '.parallax')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'api-keys.json'), '{"openai":{"data":"a2V5","encrypted":false,"origin":"https://api.openai.com"}}')
    await writeFile(join(legacy, 'chatgpt.json'), '{"accounts":{}}')
    await writeFile(join(legacy, 'notes.txt'), 'not ours')

    await adoptLegacyData(target, legacy)
    expect(JSON.parse(await readFile(join(target, 'api-keys.json'), 'utf8')).openai.origin).toBe('https://api.openai.com')
    expect(existsSync(join(target, 'chatgpt.json'))).toBe(true)
    expect(existsSync(join(target, 'notes.txt'))).toBe(false)
    // The old copies of the keys are gone, other files are left alone.
    expect(existsSync(join(legacy, 'api-keys.json'))).toBe(false)
    expect(existsSync(join(legacy, 'notes.txt'))).toBe(true)

    // Once the new folder exists, nothing is copied again.
    await writeFile(join(legacy, 'api-keys.json'), '{}')
    await adoptLegacyData(target, legacy)
    expect(JSON.parse(await readFile(join(target, 'api-keys.json'), 'utf8')).openai).toBeDefined()
  })
})
