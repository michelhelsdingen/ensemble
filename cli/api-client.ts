/**
 * Shared HTTP API client for Ensemble CLI tools.
 *
 * Rationale:
 * - Resolves JSON payloads on HTTP 4xx/5xx responses to preserve backward compatibility
 *   with existing CLI callers and exit code handling.
 * - Explicitly terminates timed-out sockets via req.destroy() so pending promises reject
 *   and connections do not hang.
 */

import http from 'node:http'

export interface ApiClientOptions {
  baseUrl?: string
  getTimeoutMs?: number
  postTimeoutMs?: number
  urlMode?: 'resolve' | 'concat'
}

export interface ApiClient {
  baseUrl: string
  apiGet<T>(path: string): Promise<T>
  apiPost<T = unknown>(path: string, body: unknown): Promise<T>
}

export function getDefaultApiBase(): string {
  return process.env.ENSEMBLE_URL || 'http://localhost:23000'
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl !== undefined && options.baseUrl !== '')
    ? options.baseUrl
    : getDefaultApiBase()
  const getTimeoutMs = options.getTimeoutMs ?? 5000
  const postTimeoutMs = options.postTimeoutMs ?? 5000
  const urlMode = options.urlMode ?? 'resolve'

  function request<T>(
    path: string,
    method: 'GET' | 'POST',
    timeoutMs: number,
    body?: unknown,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const urlStr = urlMode === 'concat' ? `${baseUrl}${path}` : new URL(path, baseUrl).toString()
      let payload: string | undefined
      const headers: Record<string, string | number> = {}

      if (method === 'POST') {
        payload = JSON.stringify(body)
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = Buffer.byteLength(payload)
      }

      const req = http.request(urlStr, {
        method,
        headers,
        timeout: timeoutMs,
      }, (res) => {
        let data = ''
        res.on('data', chunk => {
          data += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
        res.on('error', reject)
      })

      req.on('timeout', () => {
        const err = new Error(`Request timed out after ${timeoutMs}ms`)
        req.destroy(err)
        reject(err)
      })

      req.on('error', reject)

      if (payload !== undefined) {
        req.write(payload)
      }
      req.end()
    })
  }

  return {
    baseUrl,
    apiGet<T>(path: string): Promise<T> {
      return request<T>(path, 'GET', getTimeoutMs)
    },
    apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
      return request<T>(path, 'POST', postTimeoutMs, body)
    },
  }
}
