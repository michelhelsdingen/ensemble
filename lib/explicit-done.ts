export const EXPLICIT_DONE_SENTINEL = '<<COLLAB_DONE>>'

/** A terminal marker closes work; mentions inside other text do not. */
export function isExplicitDone(content: string): boolean {
  return content.trimEnd().endsWith(EXPLICIT_DONE_SENTINEL)
}
