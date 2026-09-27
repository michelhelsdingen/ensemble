import { availableAgentKeys, loadAgentsConfig } from '../lib/agent-config'

if (process.argv[2] === 'keys') {
  process.stdout.write(JSON.stringify(availableAgentKeys()))
} else if (process.argv[2] === 'color') {
  process.stdout.write(loadAgentsConfig()[process.argv[3]]?.color ?? '')
} else {
  process.exitCode = 1
}
