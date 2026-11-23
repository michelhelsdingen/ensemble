/**
 * De achtergrondwachter van de skill.
 *
 * De skill liet de AI wachten met een lus die na 600 s afhaakte, terwijl 5 van
 * de 8 gemeten runs langer duurden (894 tot 1278 s). collab-wait.sh wacht tot
 * .finished of summary.txt, kijkt elke 2 s, en zegt bij het bereiken van zijn
 * grens expliciet COLLAB_WAIT_TIMEOUT (exit 2): het team draait nog, wacht opnieuw.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = path.resolve(process.cwd(), 'scripts/collab-wait.sh')
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-wait-'))
  fs.mkdirSync(path.join(root, 'team-1'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function run(args: string[]) {
  const begin = Date.now()
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8', env: { ...process.env, COLLAB_RUNTIME_ROOT: root, COLLAB_WAIT_POLL: '0.1' },
  })
  return { ...result, seconds: (Date.now() - begin) / 1000 }
}

describe('collab-wait.sh', () => {
  it('drukt COLLAB_COMPLETE en de samenvatting zodra summary.txt er is', async () => {
    const child = spawn('bash', [script, 'team-1'], {
      env: { ...process.env, COLLAB_RUNTIME_ROOT: root, COLLAB_WAIT_POLL: '0.1' },
    })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(out).toBe('')
    fs.writeFileSync(path.join(root, 'team-1', 'summary.txt'), 'Alles gebouwd\n')
    const code = await new Promise(resolve => child.on('close', resolve))
    expect(code).toBe(0)
    expect(out).toBe('COLLAB_COMPLETE\nAlles gebouwd\n')
  })

  it('is ook klaar met alleen .finished', () => {
    fs.writeFileSync(path.join(root, 'team-1', '.finished'), '')
    const result = run(['team-1'])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('COLLAB_COMPLETE\n')
  })

  it('meldt COLLAB_WAIT_TIMEOUT met exit 2 bij het bereiken van de grens', () => {
    const result = run(['team-1', '--max', '1'])
    expect(result.status).toBe(2)
    expect(result.stdout.trim()).toBe('COLLAB_WAIT_TIMEOUT')
    expect(result.seconds).toBeGreaterThanOrEqual(1)
    expect(result.seconds).toBeLessThan(5)
  })

  it('heeft 3300 s als standaardgrens en kijkt standaard elke 2 s', () => {
    const bron = fs.readFileSync(script, 'utf8')
    expect(bron).toMatch(/^MAX=3300$/m)
    expect(bron).toMatch(/COLLAB_WAIT_POLL:-2\}/)
  })

  it('weigert een onbekend team, een ongeldig id en een ongeldige --max', () => {
    expect(run(['bestaat-niet']).status).toBe(1)
    expect(run(['..']).status).toBe(1)
    expect(run(['team-1', '--max', 'veel']).status).toBe(1)
    expect(run(['team-1', '--onzin']).status).toBe(1)
  })
})
