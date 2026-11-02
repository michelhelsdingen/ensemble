export interface PromptStartCheck {
  hasStarted: () => boolean | Promise<boolean>
  retry: () => Promise<void>
  waitMs?: number
  pollMs?: number
}

/** A team message from this agent is proof that its prompt was executed. */
export async function confirmPromptStart({
  hasStarted, retry, waitMs = 20_000, pollMs = 500,
}: PromptStartCheck): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (await hasStarted()) return true
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
    }
    if (await hasStarted()) return true
    if (attempt < 2) await retry()
  }
  return false
}
