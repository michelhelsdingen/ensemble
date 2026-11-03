import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterAll, expect, it } from 'vitest'

const root = fs.mkdtempSync(path.resolve('tmp/launch-selection-'))
const scripts = path.join(root, 'scripts')
fs.mkdirSync(scripts)
for (const name of ['collab-launch.sh', 'collab-paths.sh', 'agent-config-query.ts']) fs.copyFileSync(path.resolve('scripts', name), path.join(scripts, name))
const lib = path.join(root, 'lib')
fs.mkdirSync(lib)
for (const name of ['agent-config.ts', 'ensemble-config.ts']) fs.copyFileSync(path.resolve('lib', name), path.join(lib, name))
fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
fs.copyFileSync(path.resolve('package.json'), path.join(root, 'package.json'))
fs.copyFileSync(path.resolve('agents.json'), path.join(root, 'agents.json'))
fs.writeFileSync(path.join(scripts, 'collab-preflight.sh'), [
  '#!/bin/bash',
  'printf "%s|%s" "$1" "$COLLAB_AGENTS_SOURCE" > "$TEST_REQUEST"',
  'if [ -n "$TEST_OVERRIDE" ]; then printf "%s\\n" "$TEST_OVERRIDE" > "$COLLAB_OVERRIDE_FILE"; fi',
  'exit "$TEST_PREFLIGHT_EXIT"',
].join('\n'), { mode: 0o755 })
fs.writeFileSync(path.join(root, 'curl'), '#!/bin/bash\nfor arg in "$@"; do\ncase "$arg" in @*) cp "${arg#@}" "$TEST_PAYLOAD"; exit 23;; esac\ndone\necho "{}"\n', { mode: 0o755 })
const plan = path.join(root, 'plan.sh')
fs.writeFileSync(plan, [
  '#!/bin/bash',
  'printf "%s" "$1" > "$TEST_PLAN_TASK"',
  'printf "%s" "$TEST_PLAN_OUTPUT"',
  'exit "$TEST_PLAN_EXIT"',
].join('\n'), { mode: 0o755 })
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function run(options: {
  agents?: string; template?: string; planExit?: string; override?: string;
  oldOverride?: string; skipPreflight?: boolean; configPlan?: boolean;
  task?: string; preflightExit?: string; envAgents?: string; noPlan?: boolean;
  extraPath?: string; planOutput?: string
} = {}) {
  const overrideFile = path.join(root, 'override')
  fs.rmSync(overrideFile, { force: true })
  fs.rmSync(path.join(root, 'plan-task'), { force: true })
  fs.rmSync(path.join(root, 'payload'), { force: true })
  if (options.oldOverride) fs.writeFileSync(overrideFile, options.oldOverride)
  const config = path.join(root, 'config.json')
  fs.writeFileSync(config, JSON.stringify(options.configPlan ? { planCommand: plan } : {}))
  const args = [path.join(scripts, 'collab-launch.sh'), root, options.task ?? 'Inspect code']
  if (options.agents !== undefined || options.template !== undefined) args.push(options.agents ?? '')
  if (options.template !== undefined) args.push(options.template)
  const result = spawnSync('/bin/bash', args, {
    encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TMPDIR: root,
      COLLAB_AGENTS: options.envAgents ?? '', COLLAB_SKIP_PREFLIGHT: options.skipPreflight ? '1' : '0',
      COLLAB_OVERRIDE_FILE: overrideFile, COLLAB_WORKTREE: 'team', ENSEMBLE_CONFIG: config,
      ENSEMBLE_AGENTS_CONFIG: path.join(root, 'agents.json'),
      ENSEMBLE_AGENTS_EXTRA: options.extraPath ?? process.env.ENSEMBLE_AGENTS_EXTRA,
      ENSEMBLE_PLAN_CMD: options.configPlan || options.noPlan ? '' : plan, ENSEMBLE_URL: 'http://unused.invalid',
      TEST_REQUEST: path.join(root, 'request'), TEST_PAYLOAD: path.join(root, 'payload'),
      TEST_PLAN_TASK: path.join(root, 'plan-task'),
      TEST_PLAN_OUTPUT: options.planOutput ?? '{"agents":["agy","mimo"],"template":"implement","reason":"capacity"}',
      TEST_PLAN_EXIT: options.planExit ?? '0', TEST_OVERRIDE: options.override ?? '',
      TEST_PREFLIGHT_EXIT: options.preflightExit ?? '0',
    },
  })
  const payload = fs.existsSync(path.join(root, 'payload')) ? JSON.parse(fs.readFileSync(path.join(root, 'payload'), 'utf8')) : undefined
  return { result, payload, request: fs.existsSync(path.join(root, 'request')) ? fs.readFileSync(path.join(root, 'request'), 'utf8') : '' }
}

it('uses configured plan agents and template before preflight', () => {
  const { result, payload, request } = run({ configPlan: true })
  expect(request).toBe('agy,mimo|plan')
  expect(payload.agents.map((agent: {program: string}) => agent.program)).toEqual(['agy', 'mimo'])
  expect(payload.templateName).toBe('implement')
  expect(payload.worktree).toBe('team')
  expect(result.stdout).toContain('Plan: agents=agy,mimo, template=implement (capacity)')
  expect(result.stdout).not.toContain('Auto-fallback')
})

it('accepts plan agents from the merged user config', () => {
  const extraPath = path.join(root, 'user-agents.json')
  fs.writeFileSync(extraPath, JSON.stringify({ custom: {
    name: 'custom', command: 'custom', flags: [], readyMarker: '>',
    inputMethod: 'sendKeys', color: 'cyan', icon: '*',
  } }))
  const { payload, request } = run({
    extraPath,
    planOutput: JSON.stringify({ agents: ['agy', 'custom'], template: 'implement', reason: 'capacity' }),
  })
  expect(request).toBe('agy,custom|plan')
  expect(payload.agents.map((agent: {program: string}) => agent.program)).toEqual(['agy', 'custom'])
})

it('falls back to the default pair when planning fails', () => {
  const { payload, request } = run({ planExit: '1' })
  expect(request).toBe('|env')
  expect(payload.agents.map((agent: {program: string}) => agent.program)).toEqual(['codex', 'claude code'])
})

it('uses the default pair when no plan is configured', () => {
  const { payload } = run({ noPlan: true })
  expect(payload.agents.map((agent: {program: string}) => agent.program)).toEqual(['codex', 'claude code'])
})

it('does not call the plan for explicit agents', () => {
  const { payload, request } = run({ agents: 'gemini,claude', template: 'review' })
  expect(request).toBe('gemini,claude|explicit')
  expect(payload.agents.map((agent: {program: string}) => agent.program)).toEqual(['gemini', 'claude'])
  expect(payload.templateName).toBe('review')
  expect(fs.existsSync(path.join(root, 'plan-task'))).toBe(false)
})

it('uses an explicit template over the plan template', () => {
  const { payload } = run({ template: 'review' })
  expect(payload.agents.map((agent: {program: string}) => agent.program)).toEqual(['agy', 'mimo'])
  expect(payload.templateName).toBe('review')
})

it('does not call the plan for COLLAB_AGENTS and keeps fallback enabled', () => {
  const { payload, request } = run({ envAgents: 'codex,mimo', override: 'mimo' })
  expect(request).toBe('codex,mimo|env')
  expect(payload.agents.map((agent: {program: string}) => agent.program)).toEqual(['mimo'])
  expect(fs.existsSync(path.join(root, 'plan-task'))).toBe(false)
})

it('uses preflight fallback for planned agents', () => {
  const { payload, request, result } = run({ override: 'mimo' })
  expect(request).toBe('agy,mimo|plan')
  expect(payload.agents.map((agent: {program: string}) => agent.program)).toEqual(['mimo'])
  expect(result.stdout).toContain('Auto-fallback: agy,mimo -> mimo (zie preflight)')
  expect(result.stdout).not.toContain('Auto-fallback aktief')
})

it('does not print a fallback line when preflight keeps plan agents', () => {
  const { result } = run({ configPlan: true, override: 'agy,mimo' })
  expect(result.stdout).not.toContain('Auto-fallback')
})

it('prints the change when preflight replaces a plan agent', () => {
  const { result } = run({
    configPlan: true,
    planOutput: JSON.stringify({ agents: ['codex', 'mimo'], template: 'implement', reason: 'capacity' }),
    override: 'agy,mimo',
  })
  expect(result.stdout).toContain('Auto-fallback: codex -> agy (zie preflight)')
  expect(result.stdout).not.toContain('Auto-fallback aktief')
})

it('ignores an old override when this run writes none', () => {
  const { payload } = run({ oldOverride: 'grok', skipPreflight: true, planExit: '1' })
  expect(payload.agents.map((agent: {program: string}) => agent.program)).toEqual(['codex', 'claude code'])
})

it('passes shell metacharacters in the task literally', () => {
  const task = 'check $(touch bad) ; `echo no` "quoted"'
  const { payload } = run({ task })
  expect(fs.readFileSync(path.join(root, 'plan-task'), 'utf8')).toBe(task)
  expect(fs.existsSync(path.join(root, 'bad'))).toBe(false)
  expect(payload.agents.map((agent: {program: string}) => agent.program)).toEqual(['agy', 'mimo'])
})

it('preserves the preflight failure code', () => {
  expect(run({ preflightExit: '7' }).result.status).toBe(7)
})

it('preserves the startup-dialog failure code', () => {
  expect(run({ preflightExit: '9' }).result.status).toBe(9)
})

// 03-11-2026: gestart met "codex,claude", vier agents aan het werk. De
// launcher deed het goed, maar het team wist niet dat de ploeg met de hand was
// samengesteld, dus de service vulde hem vier minuten later aan met agy en glm.
it('tells the team that a named line-up may not be substituted', () => {
  const { payload } = run({ agents: 'codex,claude' })
  expect(payload.agents.map((agent: {program: string}) => agent.program)).toEqual(['codex', 'claude'])
  expect(payload.agentsExplicit).toBe(true)
})

it('leaves the field off when the line-up came from a plan or the default', () => {
  expect(run({ configPlan: true }).payload.agentsExplicit).toBeUndefined()
  expect(run({ envAgents: 'agy,mimo', noPlan: true }).payload.agentsExplicit).toBeUndefined()
})
