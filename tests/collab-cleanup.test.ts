/**
 * collab-cleanup.sh must also clear abandoned runtime directories.
 *
 * Until 2026-09 it only looked at directories with a .finished marker. A team
 * that never got going (the service wrote prompts, the launch then failed) or
 * a stray lock directory left no marker and stayed forever: on 2026-09-03 the
 * runtime root held 22 such directories next to 10 finished ones.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CLEANUP = path.resolve(process.cwd(), 'scripts/collab-cleanup.sh')
const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 3600 * 1000)

function run(root: string, ...args: string[]): string {
  return execFileSync(CLEANUP, args, {
    env: { ...process.env, COLLAB_RUNTIME_ROOT: root },
    encoding: 'utf8',
  })
}

function makeDir(root: string, name: string, files: Record<string, string>, old: boolean): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
  if (old) ageEverything(dir)
  return dir
}

/** Set an old mtime on a directory and everything below it, subdirectories included. */
function ageEverything(entry: string): void {
  if (fs.statSync(entry).isDirectory()) {
    for (const child of fs.readdirSync(entry)) ageEverything(path.join(entry, child))
  }
  fs.utimesSync(entry, TWO_DAYS_AGO, TWO_DAYS_AGO)
}

describe('collab-cleanup.sh abandoned directories', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-cleanup-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('removes an old directory that never produced messages', () => {
    const dir = makeDir(root, 'never-started', { 'prompts/codex-1.txt': 'x' }, true)
    run(root, '--force')
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('removes an old directory holding only a lock file', () => {
    const dir = makeDir(root, 'team-say-lock', { 'messages.jsonl.lock': '' }, true)
    run(root, '--force')
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('keeps a fresh directory without messages, the team may still be starting', () => {
    const dir = makeDir(root, 'starting', { 'prompts/codex-1.txt': 'x' }, false)
    run(root, '--force')
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('keeps an old unfinished directory that has messages', () => {
    const dir = makeDir(root, 'long-runner', { 'messages.jsonl': '{"from":"codex-1"}\n' }, true)
    run(root, '--force')
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('only reports in dry-run mode', () => {
    const dir = makeDir(root, 'never-started', { 'prompts/codex-1.txt': 'x' }, true)
    const out = run(root)
    expect(fs.existsSync(dir)).toBe(true)
    expect(out).toContain('never-started')
  })
})
