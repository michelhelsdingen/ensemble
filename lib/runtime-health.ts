export type RuntimeHealth = {
  executable: 'present' | 'missing'
  repoRead: 'readable' | 'unreachable'
  spawnReady: boolean
  detail?: string
}

export function checkRuntimeHealth(deps: {
  execPath: string
  templatesPath: string
  exists: (p: string) => boolean
  readFile: (p: string) => void
}): RuntimeHealth {
  const executable = deps.exists(deps.execPath) ? 'present' : 'missing'
  let repoRead: RuntimeHealth['repoRead'] = 'readable'
  let detail: string | undefined
  try {
    deps.readFile(deps.templatesPath)
  } catch (error) {
    repoRead = 'unreachable'
    detail = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : String(error)
  }
  return {
    executable,
    repoRead,
    spawnReady: executable === 'present' && repoRead === 'readable',
    ...(detail ? { detail } : {}),
  }
}
