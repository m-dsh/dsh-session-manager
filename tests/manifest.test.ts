import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('插件 manifest', () => {
  it('保持包名、bundle patch 和 Client 入口一致', () => {
    const root = resolve(import.meta.dirname, '..')
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const patch = readFileSync(resolve(root, manifest.dsh.bundle.patch), 'utf8')
    expect(manifest.name).toBe('dsh-session-manager')
    expect(patch).toContain(`name: '${manifest.name}'`)
    expect(patch).toContain(`id: ${manifest.name}`)
    expect(manifest.dsh.engines.dsh).toBe('>=0.2.1-rc.1 <0.3.0-0')
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-settings')
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-conversation')
    if (manifest.dsh?.client) {
      expect(manifest.exports['./client']?.default).toBe('./lib/client.js')
    } else {
      expect(manifest.exports['./client']).toBeUndefined()
    }
  })
})
