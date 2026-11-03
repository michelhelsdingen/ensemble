import { availableAgentKeys, loadAgentsConfig } from '../lib/agent-config'

if (process.argv[2] === 'keys') {
  process.stdout.write(JSON.stringify(availableAgentKeys()))
} else if (process.argv[2] === 'color') {
  process.stdout.write(loadAgentsConfig()[process.argv[3]]?.color ?? '')
} else if (process.argv[2] === 'input-method') {
  const config = loadAgentsConfig()
  const name = process.argv[3] ?? ''
  const key = config[name] ? name : name.replace(/-\d+$/, '')
  const method = config[key]?.inputMethod
  if (method) process.stdout.write(method)
  else process.exitCode = 1
} else {
  process.exitCode = 1
}
