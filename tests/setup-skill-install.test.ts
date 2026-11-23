/**
 * De installer overschrijft geen lokaal aangepaste skill.
 *
 * setup-claude-code.sh kopieerde skill/SKILL.md zonder te kijken over de
 * geïnstalleerde skill heen, waarmee lokale afspraken stil verdwenen. Nu: eerst
 * een backup met datum, overschrijven alleen als de geïnstalleerde versie gelijk
 * is aan wat een eerdere installatie schreef of met --force, en anders melden
 * dat de lokale versie afwijkt en hoe je de verschillen ziet.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let home: string
let fakeRepo: string
const installed = () => path.join(home, '.claude/skills/collab/SKILL.md')
const backups = () => fs.readdirSync(path.dirname(installed())).filter(f => f.startsWith('SKILL.md.bak-'))

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-setup-home-'))
  fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-setup-repo-'))
  fs.mkdirSync(path.join(fakeRepo, 'scripts'))
  fs.mkdirSync(path.join(fakeRepo, 'skill'))
  fs.copyFileSync(path.resolve('scripts/setup-claude-code.sh'), path.join(fakeRepo, 'scripts/setup-claude-code.sh'))
  setTemplate('versie 1: gebruik __ENSEMBLE_DIR__/scripts')
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(fakeRepo, { recursive: true, force: true })
})

const setTemplate = (text: string) => fs.writeFileSync(path.join(fakeRepo, 'skill/SKILL.md'), `${text}\n`)
const install = (...args: string[]) => {
  const result = spawnSync('bash', [path.join(fakeRepo, 'scripts/setup-claude-code.sh'), ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home },
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

describe('setup-claude-code.sh en de geïnstalleerde skill', () => {
  it('installeert een verse skill zonder backup', () => {
    const result = install()
    expect(result.status).toBe(0)
    expect(fs.readFileSync(installed(), 'utf8')).toBe(`versie 1: gebruik ${fakeRepo}/scripts\n`)
    expect(backups()).toEqual([])
  })

  it('werkt een door de installer geschreven skill bij, met een backup van de oude', () => {
    install()
    setTemplate('versie 2: gebruik __ENSEMBLE_DIR__/scripts')
    const result = install()
    expect(result.status).toBe(0)
    expect(fs.readFileSync(installed(), 'utf8')).toContain('versie 2')
    expect(backups()).toHaveLength(1)
    const backup = path.join(path.dirname(installed()), backups()[0])
    expect(fs.readFileSync(backup, 'utf8')).toContain('versie 1')
    expect(backups()[0]).toMatch(/^SKILL\.md\.bak-\d{8}-\d{6}$/)
  })

  it('laat een lokaal aangepaste skill staan en zegt hoe je de verschillen ziet', () => {
    install()
    fs.appendFileSync(installed(), 'lokale afspraak: eigen regel\n')
    setTemplate('versie 2: gebruik __ENSEMBLE_DIR__/scripts')
    const result = install()
    expect(result.status).toBe(0)
    expect(fs.readFileSync(installed(), 'utf8')).toContain('lokale afspraak: eigen regel')
    expect(fs.readFileSync(installed(), 'utf8')).not.toContain('versie 2')
    expect(result.out).toContain('not overwritten')
    expect(result.out).toContain('diff -u')
    expect(result.out).toContain('--force')
    // De nieuwe versie staat ernaast, zodat de diff ook werkt.
    expect(fs.readFileSync(path.join(path.dirname(installed()), 'SKILL.md.new'), 'utf8')).toContain('versie 2')
  })

  it('beschermt ook een skill uit een installer die nog geen hash bijhield', () => {
    fs.mkdirSync(path.dirname(installed()), { recursive: true })
    fs.writeFileSync(installed(), 'handgeschreven skill\n')
    const result = install()
    expect(fs.readFileSync(installed(), 'utf8')).toBe('handgeschreven skill\n')
    expect(result.out).toContain('not overwritten')
  })

  it('overschrijft met --force, na een backup', () => {
    install()
    fs.appendFileSync(installed(), 'lokale afspraak: eigen regel\n')
    setTemplate('versie 2: gebruik __ENSEMBLE_DIR__/scripts')
    const result = install('--force')
    expect(result.status).toBe(0)
    expect(fs.readFileSync(installed(), 'utf8')).toContain('versie 2')
    expect(backups()).toHaveLength(1)
    expect(fs.readFileSync(path.join(path.dirname(installed()), backups()[0]), 'utf8')).toContain('lokale afspraak: eigen regel')
  })

  it('doet niets als de skill al gelijk is', () => {
    install()
    const result = install()
    expect(result.out).toContain('already up to date')
    expect(backups()).toEqual([])
  })

  it('geeft collab-wait.sh toestemming', () => {
    install()
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'))
    expect(settings.permissions.allow).toContain(`Bash(${fakeRepo}/scripts/collab-wait.sh:*)`)
  })
})
