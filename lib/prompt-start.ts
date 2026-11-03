export interface PromptStartCheck {
  hasStarted: () => boolean | Promise<boolean>
  retry: () => Promise<void>
  /**
   * Is deze agent zichtbaar aan het werk? Zo ja, dan wachten we door zonder de
   * prompt opnieuw te sturen.
   *
   * Gemeten 03-11-2026 (team ee1b35b0): glm-1 nam de prompt aan, ging aan het
   * werk en kreeg hem na 20s en na 40s nog twee keer in de pane geplakt omdat
   * hij nog niets had gezegd. Elke kopie was werk dat hij ook moest afhandelen;
   * zijn eerste bericht kwam pas na 2m40s. Opnieuw sturen is alleen zinnig als
   * de pane stilstaat.
   */
  busy?: () => boolean | Promise<boolean>
  waitMs?: number
  pollMs?: number
  /** Harde bovengrens, zodat een eeuwig bezige pane de belofte niet openhoudt. */
  maxTotalMs?: number
}

/** A team message from this agent is proof that its prompt was executed. */
export async function confirmPromptStart({
  hasStarted, retry, busy, waitMs = 20_000, pollMs = 500, maxTotalMs = 180_000,
}: PromptStartCheck): Promise<boolean> {
  const start = Date.now()
  let asks = 0
  while (Date.now() - start < maxTotalMs) {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (await hasStarted()) return true
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
    }
    if (await hasStarted()) return true
    if (busy && await busy()) continue
    if (asks >= 2) return false
    asks++
    await retry()
  }
  return false
}
