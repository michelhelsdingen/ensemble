/**
 * Docs-consistency tests.
 *
 * These exist because the documentation drifted away from the code repeatedly, and every time
 * it was a human who eventually noticed. Each assertion here encodes a drift that actually
 * happened, so the next one fails in CI instead of on a reader:
 *
 *  - `--full-auto` stayed in the agents.json example for months after Codex CLI 0.147.0 removed
 *    it, so anyone who copy-pasted the example got `unexpected argument '--full-auto' found`.
 *  - SKILL.md advertised an agent key (`fable`) that is not in agents.json. Unknown keys are not
 *    an error: resolveAgentProgram() falls back to claude, so it silently spawned a second claude.
 *  - Three separate pages called Claude Code the default lead while collab-launch.sh has always
 *    built its payload with codex as lead.
 *
 * The rule of thumb for adding one: assert something derivable from the code, not something a
 * writer has to keep in their head.
 */
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** Pages that describe the current system. CHANGELOG and demo/ are historical records. */
const LIVE_DOCS = [
  'README.md',
  'skill/SKILL.md',
  'docs/index.md',
  'docs/getting-started.md',
  'docs/configuration.md',
  'docs/collab-scripts.md',
  'docs/cli.md',
  'docs/api.md',
  'docs/architecture.md',
  'docs/TROUBLESHOOTING.md',
]

type AgentsConfig = Record<string, { flags: string[] }>
// These assertions cover shipped agents only. User entries are local and cannot be
// required to appear in the repository documentation.
const agents = JSON.parse(read('agents.json')) as AgentsConfig

describe('docs match agents.json', () => {
  it('documents the real flags for every agent the docs name', () => {
    const config = read('docs/configuration.md')
    for (const key of ['codex', 'claude', 'grok', 'agy']) {
      for (const flag of agents[key].flags) {
        expect(
          config,
          `configuration.md should document ${key}'s real flag ${flag} from agents.json`,
        ).toContain(flag)
      }
    }
  })

  it('never presents a removed CLI flag as one to use', () => {
    // Codex CLI 0.147.0 removed --full-auto; Claude Code moved to --permission-mode.
    // Mentioning them is fine and useful, as long as the line says they are gone.
    const removed = ['--full-auto', '--dangerously-skip-permissions']
    const explains = /removed|replaces|no longer|unexpected argument|older config/i

    for (const rel of LIVE_DOCS) {
      const lines = read(rel).split('\n')
      lines.forEach((line, i) => {
        for (const flag of removed) {
          // This flag remains valid for agy and mimo; its removal was specific to Claude.
          if (flag === '--dangerously-skip-permissions' && /\b(agy|mimo)\b/i.test(line) && !/\bclaude\b/i.test(line)) continue
          if (line.includes(flag) && !explains.test(line)) {
            throw new Error(
              `${rel}:${i + 1} presents ${flag} without saying it was removed:\n  ${line.trim()}`,
            )
          }
        }
      })
    }
  })

  it('mentions every shipped agent where a reader would look for it', () => {
    // The other direction of the check below: an agent can also exist in agents.json and be
    // documented nowhere. Grok shipped that way and was invisible on the docs site, which is
    // indistinguishable from not supporting it.
    const pages = {
      'docs/configuration.md': 'the agent reference page',
      'docs/index.md': 'the landing page, where people decide whether this does what they need',
    }
    for (const [rel, why] of Object.entries(pages)) {
      const text = read(rel).toLowerCase()
      for (const key of Object.keys(agents)) {
        expect(text, `${rel} (${why}) never mentions the "${key}" agent from agents.json`)
          .toContain(key)
      }
    }
  })

  it('only advertises agent keys that exist in agents.json', () => {
    // An unknown key is not an error at runtime: resolveAgentProgram() falls back to claude,
    // so a key that only exists in the docs silently spawns a duplicate agent.
    const skill = read('skill/SKILL.md')
    const match = skill.match(/Available keys:\s*(.+)/)
    expect(match, 'SKILL.md should list the available agent keys').not.toBeNull()

    const advertised = [...match![1].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1])
    expect(advertised.length).toBeGreaterThan(0)

    for (const key of advertised) {
      expect(Object.keys(agents), `SKILL.md advertises "${key}", which is not in agents.json`)
        .toContain(key)
    }
  })
})

describe('docs match collab-launch.sh', () => {
  const launch = read('scripts/collab-launch.sh')

  it('names the same default lead the launcher builds', () => {
    // The fallback payload in collab-launch.sh is the single source of truth for "the default
    // team". Extract the program marked lead rather than trusting a sentence in a doc.
    // Match the hardcoded fallback specifically. The branch above it builds the lead from
    // names[0], which is a variable, not the default.
    const leadMatch = launch.match(/\{'program':\s*'([^']+)',\s*'role':\s*'lead'/)
    expect(leadMatch, 'collab-launch.sh should hardcode a default lead in its fallback payload')
      .not.toBeNull()

    const lead = leadMatch![1]
    expect(lead).toBe('codex')

    // Any page claiming claude leads by default contradicts the code above.
    const claimsClaudeLeads = /Claude Code \(lead\)|claude \(lead\)|pairs \*\*Claude Code \+ Codex\*\*/i
    for (const rel of LIVE_DOCS) {
      const lines = read(rel).split('\n')
      lines.forEach((line, i) => {
        if (claimsClaudeLeads.test(line)) {
          throw new Error(
            `${rel}:${i + 1} says Claude Code is the default lead, but collab-launch.sh makes ` +
              `${lead} the lead:\n  ${line.trim()}`,
          )
        }
      })
    }
  })

  it('documents every monitor mode the launcher accepts', () => {
    // Each mode the launcher branches on has to be discoverable somewhere a reader will look.
    const modes = ['herdr', 'tmux', 'iterm', 'none']
    for (const mode of modes) {
      expect(launch, `collab-launch.sh should handle COLLAB_MONITOR=${mode}`)
        .toContain(mode)
    }

    const readme = read('README.md')
    for (const mode of modes) {
      expect(readme, `README should document the ${mode} monitor mode`).toContain(mode)
    }
  })

  it('documents the env-var fallbacks the launcher reads', () => {
    for (const envVar of ['COLLAB_AGENTS', 'COLLAB_TEMPLATE', 'COLLAB_MONITOR']) {
      expect(launch, `collab-launch.sh should read ${envVar}`).toContain(envVar)

      const documented = LIVE_DOCS.some((rel) => read(rel).includes(envVar))
      expect(documented, `${envVar} is read by collab-launch.sh but documented nowhere`).toBe(true)
    }
  })
})

describe('docs match collab-preflight.sh', () => {
  it('documents every preflight exit code the script can return', () => {
    const preflight = read('scripts/collab-preflight.sh')

    // Codes the script actually exits with, taken from its fail() call sites.
    const used = new Set(
      [...preflight.matchAll(/^\s*fail\s+(\d+)/gm)].map((m) => m[1]),
    )
    expect(used.size).toBeGreaterThan(0)

    const troubleshooting = read('docs/TROUBLESHOOTING.md')
    const scripts = read('docs/collab-scripts.md')
    for (const code of used) {
      const documented =
        new RegExp(`\\b${code}\\b`).test(scripts) || new RegExp(`\\b${code}\\b`).test(troubleshooting)
      expect(documented, `preflight can exit ${code} but no doc explains it`).toBe(true)
    }
  })
})
