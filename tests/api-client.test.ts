import http from 'node:http'
import { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApiClient, getDefaultApiBase } from '../cli/api-client'

describe('cli/api-client', () => {
  let server: http.Server
  let serverUrl: string
  let slowRequestAborted = false

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

      if (url.pathname === '/slow') {
        req.on('close', () => {
          slowRequestAborted = true
        })
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ delayed: true }))
          }
        }, 200)
        return
      }

      if (url.pathname === '/network-error') {
        req.socket.destroy()
        return
      }

      if (url.pathname === '/broken-stream') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.write('{"partial":')
        setTimeout(() => {
          res.destroy()
        }, 20)
        return
      }

      if (url.pathname === '/invalid-json') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('not json data')
        return
      }

      if (url.pathname === '/error-404') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      if (url.pathname === '/error-500') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'server failure' }))
        return
      }

      if (req.method === 'POST') {
        let body = ''
        req.on('data', chunk => {
          body += chunk
        })
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            received: JSON.parse(body),
            contentType: req.headers['content-type'],
            contentLength: req.headers['content-length'],
          }))
        })
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, path: url.pathname }))
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo
        serverUrl = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  it('apiGet haalt data succesvol op en parset JSON', async () => {
    const client = createApiClient({ baseUrl: serverUrl })
    const result = await client.apiGet<{ ok: boolean; path: string }>('/test-get')
    expect(result.ok).toBe(true)
    expect(result.path).toBe('/test-get')
  })

  it('apiPost verstuurt JSON body inclusief unicode en Content-Length', async () => {
    const client = createApiClient({ baseUrl: serverUrl })
    const payload = { message: 'hallo wereld 🚀 café' }
    const result = await client.apiPost<{
      received: typeof payload
      contentType: string
      contentLength: string
    }>('/test-post', payload)

    expect(result.received).toEqual(payload)
    expect(result.contentType).toBe('application/json')
    expect(Number(result.contentLength)).toBe(Buffer.byteLength(JSON.stringify(payload)))
  })

  it('apiPost ondersteunt null body en weigert undefined', async () => {
    const client = createApiClient({ baseUrl: serverUrl })

    const nullResult = await client.apiPost<{
      received: unknown
      contentLength: string
    }>('/test-post', null)
    expect(nullResult.received).toBeNull()
    expect(Number(nullResult.contentLength)).toBe(4)

    await expect(client.apiPost('/test-post', undefined)).rejects.toThrow()
  })

  it.each(['GET', 'POST'] as const)('behoudt compatibiliteit door JSON bij HTTP 4xx en 5xx status te resolven (%s)', async (method) => {
    const client = createApiClient({ baseUrl: serverUrl })

    const res404 = method === 'GET'
      ? await client.apiGet<{ error: string }>('/error-404')
      : await client.apiPost<{ error: string }>('/error-404', { test: true })
    expect(res404.error).toBe('not found')

    const res500 = method === 'GET'
      ? await client.apiGet<{ error: string }>('/error-500')
      : await client.apiPost<{ error: string }>('/error-500', { test: true })
    expect(res500.error).toBe('server failure')
  })

  it.each(['GET', 'POST'] as const)('reject bij ongeldige JSON respons (%s)', async (method) => {
    const client = createApiClient({ baseUrl: serverUrl })
    if (method === 'GET') {
      await expect(client.apiGet('/invalid-json')).rejects.toThrow()
    } else {
      await expect(client.apiPost('/invalid-json', {})).rejects.toThrow()
    }
  })

  it.each(['GET', 'POST'] as const)('reject bij een verbroken netwerkverbinding (%s)', async (method) => {
    const client = createApiClient({ baseUrl: serverUrl })
    if (method === 'GET') {
      await expect(client.apiGet('/network-error')).rejects.toThrow()
    } else {
      await expect(client.apiPost('/network-error', {})).rejects.toThrow()
    }
  })

  it('reject en sluit socket bij timeout op GET en POST', async () => {
    slowRequestAborted = false
    const client = createApiClient({
      baseUrl: serverUrl,
      getTimeoutMs: 50,
      postTimeoutMs: 50,
    })

    await expect(client.apiGet('/slow')).rejects.toThrow(/timed out/i)
    await expect(client.apiPost('/slow', {})).rejects.toThrow(/timed out/i)

    // Wacht kort om te controleren of de server de socket close heeft ontvangen
    await new Promise(r => setTimeout(r, 60))
    expect(slowRequestAborted).toBe(true)
  })

  it('reject wanneer de responsstroom voortijdig wordt afgebroken', async () => {
    const client = createApiClient({ baseUrl: serverUrl })
    await expect(client.apiGet('/broken-stream')).rejects.toThrow()
  })

  it('ondersteunt urlMode concat en resolve met pad-prefix', async () => {
    const resolveClient = createApiClient({
      baseUrl: `${serverUrl}/prefix/`,
      urlMode: 'resolve',
    })
    const concatClient = createApiClient({
      baseUrl: `${serverUrl}/prefix`,
      urlMode: 'concat',
    })

    const resResolve = await resolveClient.apiGet<{ path: string }>('/test')
    expect(resResolve.path).toBe('/test')

    const resConcat = await concatClient.apiGet<{ path: string }>('/test')
    expect(resConcat.path).toBe('/prefix/test')
  })

  it('respecteert ENSEMBLE_URL en valt terug op default poort bij lege of afwezige waarde', () => {
    const prev = process.env.ENSEMBLE_URL
    try {
      delete process.env.ENSEMBLE_URL
      expect(getDefaultApiBase()).toBe('http://localhost:23000')

      process.env.ENSEMBLE_URL = ''
      expect(getDefaultApiBase()).toBe('http://localhost:23000')
      expect(createApiClient({ baseUrl: '' }).baseUrl).toBe('http://localhost:23000')

      process.env.ENSEMBLE_URL = 'http://127.0.0.1:24000'
      expect(getDefaultApiBase()).toBe('http://127.0.0.1:24000')
      const client = createApiClient()
      expect(client.baseUrl).toBe('http://127.0.0.1:24000')
    } finally {
      if (prev !== undefined) {
        process.env.ENSEMBLE_URL = prev
      } else {
        delete process.env.ENSEMBLE_URL
      }
    }
  })
})
