/**
 * Een geplakte prompt afmaken bij een CLI die een grote paste eerst samenvat.
 *
 * Claude toont zo'n paste als "[Pasted text #1 +412 lines]" en verzendt hem pas
 * na nog een Enter. De lus die dat deed sliep eerst en keek daarna: 1,5s, dan 3,
 * dan 6. Elke teamstart met een claude-agent betaalde dus altijd minstens
 * anderhalve seconde, ook als de prompt al bij de eerste Enter weg was, en dat
 * zit binnen de aflevering waarop de launcher wacht.
 *
 * Nu kijken we eerst. Zodra de pane iets anders laat zien dan vóór het
 * verzenden, weten we genoeg: staat er een pastemelding, dan gaat er nog een
 * Enter heen; staat die er niet, dan is de prompt verzonden en zijn we klaar.
 * De oude tijden blijven de bovengrens per ronde, dus langer wachten dan
 * voorheen kan niet.
 */

export interface PasteFollowup {
  /** Het pane-beeld van vlak voor het verzenden. */
  before: string
  capture: () => Promise<string>
  sendEnter: () => Promise<void>
  /** Bovengrens per ronde; standaard de tijden van de oude lus. */
  rounds?: number[]
  pollMs?: number
}

const PASTE_MELDING = /\[Pasted text|paste again to expand/i

export async function submitPastedPrompt({
  before, capture, sendEnter, rounds = [1500, 3000, 6000], pollMs = 150,
}: PasteFollowup): Promise<void> {
  let vorig = before
  for (const grens of rounds) {
    const deadline = Date.now() + grens
    let beeld = vorig
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
      let nu: string
      try {
        nu = await capture()
      } catch {
        // Niet te lezen: niets doen is veiliger dan een Enter die ergens anders
        // belandt. De bevestiging van de aflevering vangt dit verderop.
        return
      }
      beeld = nu
      if (nu !== vorig) break
    }
    // Geen pastemelding betekent klaar: of de prompt is verzonden (het beeld
    // veranderde), of er is niets te zien en de ronde is om. Staat de melding
    // er nog, ook na een eerdere Enter, dan gaat er nog een Enter heen, net als
    // in de oude lus, want een Enter komt niet altijd aan.
    if (!PASTE_MELDING.test(beeld)) return
    vorig = beeld
    await sendEnter()
  }
}
