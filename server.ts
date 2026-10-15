/**
 * Ensemble Server — Standalone HTTP server
 * Lightweight replacement for Next.js API routes.
 */

import http from 'http'
import fs from 'fs'
import os from 'os'
// Alias, want de request-handler gebruikt de naam `path` al voor de URL-pathname.
import nodePath from 'path'
import {
  createEnsembleTeam, getEnsembleTeam, listEnsembleTeams,
  getTeamFeed, sendTeamMessage, disbandTeam,
  COLLAB_TEMPLATES_PATH,
} from './services/ensemble-service'
import { checkRuntimeHealth } from './lib/runtime-health'

const PORT = parseInt(process.env.ENSEMBLE_PORT || process.env.ORCHESTRA_PORT || '23000', 10)
const HOST = process.env.ENSEMBLE_HOST || '127.0.0.1'
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 100
const DEFAULT_CORS_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(?::\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/i,
  /^http:\/\/\[::1\](?::\d+)?$/i,
]

type RateLimitEntry = {
  count: number
  windowStart: number
}

const rateLimitByIp = new Map<string, RateLimitEntry>()

// Periodic cleanup of stale rate limit entries to prevent unbounded Map growth
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitByIp) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitByIp.delete(ip)
    }
  }
}, 60_000)

function getAllowedCorsOrigins(): string[] {
  const configured = process.env.ENSEMBLE_CORS_ORIGIN?.trim()
  if (!configured) return []

  return configured
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
}

function isAllowedOrigin(origin: string): boolean {
  const configuredOrigins = getAllowedCorsOrigins()
  if (configuredOrigins.length > 0) return configuredOrigins.includes(origin)
  return DEFAULT_CORS_ORIGIN_PATTERNS.some(pattern => pattern.test(origin))
}

function buildCorsHeaders(origin?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }

  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }

  return headers
}

function json(res: http.ServerResponse, data: unknown, status = 200, origin?: string) {
  res.writeHead(status, buildCorsHeaders(origin))
  res.end(JSON.stringify(data))
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function getClientIp(req: http.IncomingMessage): string {
  const forwardedFor = req.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string') {
    const firstIp = forwardedFor.split(',')[0]?.trim()
    if (firstIp) return firstIp
  }

  return req.socket.remoteAddress || 'unknown'
}

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const current = rateLimitByIp.get(ip)

  if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitByIp.set(ip, { count: 1, windowStart: now })
    return false
  }

  current.count += 1
  return current.count > RATE_LIMIT_MAX_REQUESTS
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  const path = url.pathname
  const method = req.method || 'GET'
  const origin = req.headers.origin

  if (origin && !isAllowedOrigin(origin)) {
    return json(res, { error: 'CORS origin forbidden' }, 403, origin)
  }

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, buildCorsHeaders(origin))
    res.end()
    return
  }

  try {
    // Health check — always exempt from rate limiting
    if (path === '/api/v1/health') {
      // De preflight herstartte de service ooit puur op leeftijd, als proxy voor
      // "is hij met credentials gestart". ANTHROPIC_API_KEY en
      // CLAUDE_CODE_OAUTH_TOKEN staan echter niet eens in de env van de gezonde,
      // door launchd beheerde service (geverifieerd met `launchctl print`: enkel
      // PATH, HOME, XPC_SERVICE_NAME), dus die vars zeggen hier niets. claude en
      // codex bewaren hun login-status wel op schijf onder $HOME, dat de
      // launchd-plist wel correct doorgeeft. Bestandsaanwezigheid bewijst geen
      // geldig token (zelfde denkfout als de codex-probe uit #88 zou zijn), maar
      // is een eerlijker signaal dan een env var die de gezonde instantie nooit
      // heeft.
      const home = os.homedir()
      const hasClaudeCreds = fs.existsSync(nodePath.join(home, '.claude', '.credentials.json'))
      const hasCodexCreds = fs.existsSync(nodePath.join(home, '.codex', 'auth.json'))
      // Het veld heet naar wat het meet en niet naar wat je zou willen weten:
      // of de service bij de opslag kan, niet of het token daarin nog geldig is.
      // Die laatste vraag beantwoorden de live probes in de preflight.
      const credentialStore = (hasClaudeCreds || hasCodexCreds) ? 'readable' : 'unreachable'
      const runtimeHealth = checkRuntimeHealth({
        execPath: process.execPath,
        templatesPath: COLLAB_TEMPLATES_PATH,
        exists: fs.existsSync,
        readFile: file => { fs.readFileSync(file) },
      })
      return json(res, {
        status: 'healthy',
        version: '1.0.0',
        credentialStore,
        uptimeSeconds: Math.round(process.uptime()),
        ...runtimeHealth,
      }, 200, origin)
    }

    // Hier stond een uitzondering op '/api/ensemble/', wat elke route is die deze
    // server heeft: de limiet van 100/min stond daarmee volledig uit. Alleen GET
    // op een los team en zijn feed blijven vrij, want dat zijn de routes die
    // pollers echt raken: cli/monitor.ts poll elke 2s allebei (per open monitor),
    // collab-poller.sh pingt het team-detail-endpoint eens per minuut, en
    // team-read.sh raakt de feed op het tempo van de agent. De lijst-route
    // (GET /api/ensemble/teams) en alle mutaties blijven gewoon gelimiteerd.
    const isTeamPoll = method === 'GET' && /^\/api\/ensemble\/teams\/[^/]+(?:\/feed)?$/.test(path)
    if (!isTeamPoll && isRateLimited(getClientIp(req))) {
      return json(res, { error: 'Rate limit exceeded' }, 429, origin)
    }

    // List teams / Create team
    if (path === '/api/ensemble/teams') {
      if (method === 'GET') {
        const result = listEnsembleTeams()
        return json(res, result.data, result.status, origin)
      }
      if (method === 'POST') {
        let body: unknown
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
        const result = await createEnsembleTeam(body as Parameters<typeof createEnsembleTeam>[0])
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
    }

    // Team operations: /api/ensemble/teams/:id
    const teamMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)$/)
    if (teamMatch) {
      const teamId = teamMatch[1]
      if (method === 'GET') {
        const result = getEnsembleTeam(teamId)
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
      if (method === 'POST') {
        let body: Record<string, unknown>
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
        const result = await sendTeamMessage(teamId, (body.to as string) || 'team', body.content as string, body.from as string, body.id as string, body.timestamp as string)
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
      if (method === 'DELETE') {
        const result = await disbandTeam(teamId)
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
    }

    // Disband: /api/ensemble/teams/:id/disband
    const disbandMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/disband$/)
    if (disbandMatch && method === 'POST') {
      const result = await disbandTeam(disbandMatch[1])
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Feed: /api/ensemble/teams/:id/feed
    const feedMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/feed$/)
    if (feedMatch && method === 'GET') {
      const since = url.searchParams.get('since') || undefined
      const result = getTeamFeed(feedMatch[1], since)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    json(res, { error: 'Not found' }, 404, origin)
  } catch (err) {
    console.error('[Server] Error:', err)
    json(res, { error: 'Internal server error' }, 500, origin)
  }
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Ensemble] Port ${PORT} is already in use on ${HOST}. Stop the other process or set ENSEMBLE_PORT to a different port.`)
    process.exit(1)
  }

  console.error('[Ensemble] Server failed to start:', err)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`[Ensemble] Server running on http://${HOST}:${PORT}`)
  console.log(`[Ensemble] Health: http://localhost:${PORT}/api/v1/health`)
})
