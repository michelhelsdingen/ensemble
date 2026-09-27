import fs from 'fs'
import path from 'path'
import { configDefaults, defineConfig } from 'vitest/config'

// Keep test artifacts and user configuration isolated from the host machine.
const temporary = path.resolve('tmp')
const home = path.join(temporary, 'home')
fs.mkdirSync(home, { recursive: true })

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tmp/**'],
    env: {
      TMPDIR: temporary,
      HOME: home,
      COLLAB_RUNTIME_ROOT: path.join(temporary, 'test-runtime'),
      ENSEMBLE_DATA_DIR: path.join(temporary, 'data'),
      ENSEMBLE_CONFIG: path.join(temporary, 'absent-config.json'),
      ENSEMBLE_AGENTS_EXTRA: path.join(temporary, 'absent-agents.json'),
      ENSEMBLE_ROSTER_CMD: '',
      ENSEMBLE_PLAN_CMD: '',
      ENSEMBLE_EVENTS_CMD: '',
      ENSEMBLE_REPLACE_STALLED: '',
      ENSEMBLE_MEMORY_URL: 'http://localhost:1/api/memory/save',
      // Never send real notifications from a test run, even when the developer's
      // shell exports these (a test disband otherwise reaches Telegram).
      ENSEMBLE_TELEGRAM_BOT_TOKEN: '',
      ENSEMBLE_TELEGRAM_CHAT_ID: '',
      ALERT_HUB_SECRET: '',
    },
  },
})
