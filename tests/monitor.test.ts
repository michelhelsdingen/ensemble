import fs from 'node:fs'
import { createRequire } from 'node:module'
import { stripVTControlCharacters } from 'node:util'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as agentConfig from '../lib/agent-config'
import * as apiClient from '../cli/api-client'

interface Message {
  id: string
  from: string
  to: string
  content: string
  timestamp: string
  type: string
}

interface TestMonitor {
  messages: Message[]
  scrollOffset: number
  renderMessages(width: number, maxLines: number): string
  renderHeader(width: number): string
  renderInlineSummary(width: number, maxLines: number): string
  getLastAgentMessageTime(): number
}

// De CLI start main() bij import. Laad de echte klasse, maar sla uitsluitend
// die startaanroep over. Geen kopie of mock van de renderlogica.
const source = fs.readFileSync(new URL('../cli/monitor.ts', import.meta.url), 'utf8')
const mainCall = source.lastIndexOf('\nmain().catch(')
if (mainCall < 0) throw new Error('Startaanroep van monitor niet gevonden')
const compiled = ts.transpileModule(source.slice(0, mainCall).replace(/^#![^\n]*\n/, '') + '\nreturn Monitor', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const nativeRequire = createRequire(import.meta.url)
const Monitor = new Function('require', 'exports', compiled)((name: string) => {
  if (name === '../lib/agent-config') return agentConfig
  if (name === './api-client' || name === './api-client.js') return apiClient
  return nativeRequire(name)
}, {}) as new (teamId: string) => TestMonitor

const contents = [
  'claude-1 (claude -> claude @ local) has joined #collab-1789928924528-5697',
  '1 agents received their task, collaboration started',
  'Watchdog nudged claude-1: Are you still working?',
  'Watchdog marked claude-1 as stalled after 180s without progress',
]
function message(content: string, index = 0, from = 'ensemble'): Message {
  return { id: String(index), from, to: 'team', content,
    timestamp: `2026-09-20T18:00:0${index}.000Z`, type: 'chat' }
}
function monitor(messages = contents.map((content, i) => message(content, i))) {
  const instance = new Monitor('monitor-test')
  instance.messages = messages
  return instance
}
function visibleLines(output: string) {
  return stripVTControlCharacters(output).split('\n').filter(line => line.trim())
}

describe('monitor tijdlijn', () => {
  it('toont de vier ensemble-meldingen in feedvolgorde in plaats van een lege tijdlijn', () => {
    const lines = visibleLines(monitor().renderMessages(160, 20))
    expect(lines, 'De feed bevat vier meldingen, maar de tijdlijn is leeg').not.toHaveLength(0)
    const output = lines.join('\n')
    for (const content of contents) expect(output).toContain(content)
    expect(contents.map(content => output.indexOf(content))).toEqual(
      contents.map(content => output.indexOf(content)).sort((a, b) => a - b),
    )
  })

  it.each([
    [contents[0], '\x1b[90m', false],
    [contents[1], '\x1b[92m', true],
    ['🚀 2 agents received their task' + String.fromCharCode(0x2014) + ' collaboration started', '\x1b[92m', true],
    [contents[2], '\x1b[93m', true],
    [contents[3], '\x1b[91m', true],
    ['🔕 Watchdog stopped nudging claude-1 after 3 nudges without progress', '\x1b[93m', true],
    ['❌ Watchdog failed to nudge claude-1: unavailable', '\x1b[91m', true],
  ])('geeft servicemelding %s de juiste nadruk', (content, color, bold) => {
    const output = monitor([message(content)]).renderMessages(200, 10)
    const line = output.split('\n').find(line => line.includes(content))
    expect(line).toBeDefined()
    expect(line).toContain(color)
    if (bold) expect(line).toContain('\x1b[1m')
    else expect(line).not.toContain('\x1b[1m')
    expect(stripVTControlCharacters(line!)).toContain('ensemble')
  })

  it('behoudt agentinhoud en telt servicemeldingen niet als gesprek of agentactiviteit', () => {
    const instance = monitor()
    expect(stripVTControlCharacters(instance.renderHeader(120))).toContain('0 msgs')
    expect(instance.getLastAgentMessageTime()).toBe(0)
    const agent = message('Ik controleer de implementatie.', 4, 'claude-1')
    instance.messages.splice(1, 0, agent)
    const output = stripVTControlCharacters(instance.renderMessages(160, 30))
    expect(output).toContain(agent.content)
    expect(output.indexOf(agent.content)).toBeGreaterThan(output.indexOf(contents[0]))
    expect(output.indexOf(agent.content)).toBeLessThan(output.indexOf(contents[1]))
    expect(stripVTControlCharacters(instance.renderHeader(120))).toContain('1 msgs')
    expect(instance.getLastAgentMessageTime()).toBe(Date.parse(agent.timestamp))
    const summary = stripVTControlCharacters(instance.renderInlineSummary(160, 30))
    expect(summary).toContain('1 messages · 1 agents')
    expect(summary).not.toContain('Watchdog')
  })

  it('wikkelt servicemeldingen af binnen de breedte en laat terugscrollen toe', () => {
    const instance = monitor()
    const all = visibleLines(instance.renderMessages(55, 80))
    expect(all.length).toBeGreaterThan(4)
    expect(all.every(line => line.length <= 55)).toBe(true)
    expect(visibleLines(instance.renderMessages(55, 3))).toEqual(all.slice(-3))
    instance.scrollOffset = 3
    expect(visibleLines(instance.renderMessages(55, 3))).toEqual(all.slice(-6, -3))
  })
})
