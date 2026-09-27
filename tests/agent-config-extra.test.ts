import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { availableAgentKeys, clearAgentsConfigCache, loadAgentsConfig, resolveAgentProgram } from '../lib/agent-config'

let root: string
let basePath: string
let extraPath: string
let version = 0

const agent = (name: string, command = name) => ({
  name, command, flags: [], readyMarker: '>', inputMethod: 'sendKeys', color: 'cyan', icon: '*',
})
const isolatedExtraPath = process.env.ENSEMBLE_AGENTS_EXTRA

function writeExtra(entries: unknown): void {
  fs.writeFileSync(extraPath, JSON.stringify(entries))
  const changed = new Date(Date.now() + ++version * 3000)
  fs.utimesSync(extraPath, changed, changed)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-extra-'))
  basePath = path.join(root, 'base.json')
  extraPath = path.join(root, 'extra.json')
  fs.writeFileSync(basePath, JSON.stringify({ claude: agent('claude') }))
  vi.stubEnv('ENSEMBLE_AGENTS_CONFIG', basePath)
  vi.stubEnv('ENSEMBLE_AGENTS_EXTRA', extraPath)
  clearAgentsConfigCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  clearAgentsConfigCache()
  fs.rmSync(root, { recursive: true, force: true })
})

it('adds an agent to the base list', () => {
  writeExtra({ custom: agent('custom') })
  expect(availableAgentKeys()).toEqual(['claude', 'custom'])
  expect(resolveAgentProgram('custom', { strict: true }).command).toBe('custom')
})

it('replaces an existing entry in full', () => {
  writeExtra({ claude: agent('claude', 'different-cli') })
  expect(loadAgentsConfig().claude).toEqual(agent('claude', 'different-cli'))
})

it('skips invalid entries and warns once per file version', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  writeExtra({ good: agent('good'), bad: { ...agent('bad'), unsetEnv: ['lowercase'] } })
  expect(availableAgentKeys()).toEqual(['claude', 'good'])
  loadAgentsConfig()
  expect(warn).toHaveBeenCalledTimes(1)
  fs.writeFileSync(extraPath, '{broken')
  const changed = new Date(Date.now() + 6000)
  fs.utimesSync(extraPath, changed, changed)
  expect(availableAgentKeys()).toEqual(['claude'])
  expect(warn).toHaveBeenCalledTimes(2)
})

it('ignores an unreadable user file and retains the base list', () => {
  fs.mkdirSync(extraPath)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(availableAgentKeys()).toEqual(['claude'])
  expect(warn).toHaveBeenCalledTimes(1)
})

it('reloads the user file after a change', () => {
  writeExtra({ first: agent('first') })
  expect(availableAgentKeys()).toEqual(['claude', 'first'])
  writeExtra({ second: agent('second') })
  expect(availableAgentKeys()).toEqual(['claude', 'second'])
})

it('uses ENSEMBLE_AGENTS_EXTRA instead of the default path', () => {
  const home = path.join(root, 'home')
  const defaultDir = path.join(home, '.config', 'ensemble')
  fs.mkdirSync(defaultDir, { recursive: true })
  fs.writeFileSync(path.join(defaultDir, 'agents.json'), JSON.stringify({ default: agent('default') }))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  writeExtra({ explicit: agent('explicit') })
  expect(availableAgentKeys()).toEqual(['claude', 'explicit'])
  vi.stubEnv('ENSEMBLE_AGENTS_EXTRA', '')
  expect(availableAgentKeys()).toEqual(['claude', 'default'])
})

it('isolates the test suite from an agents file under the home directory', () => {
  expect(isolatedExtraPath).toBe(path.resolve('tmp', 'absent-agents.json'))
  expect(fs.existsSync(isolatedExtraPath!)).toBe(false)
  const home = path.join(root, 'home')
  const defaultDir = path.join(home, '.config', 'ensemble')
  fs.mkdirSync(defaultDir, { recursive: true })
  fs.writeFileSync(path.join(defaultDir, 'agents.json'), JSON.stringify({ personal: agent('personal') }))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.stubEnv('ENSEMBLE_AGENTS_EXTRA', isolatedExtraPath)
  expect(availableAgentKeys()).toEqual(['claude'])
})
