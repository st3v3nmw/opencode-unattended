import { JudgeUnavailable } from "./judge.ts"
import { MAX_RETRY_AFTER_MS, MAX_RETRY_TIME_MS, RETRY_DELAYS_MS } from "./limits.ts"

/** The host and port of a base URL, without scheme, credentials, path or query. */
export function hostOf(baseURL: string): string | undefined {
  try {
    return new URL(baseURL.trim()).host || undefined
  } catch {
    return undefined
  }
}

export const API_KEY_ENV = "OPENCODE_UNATTENDED_API_KEY"

/** Failures worth another try: the service is limited or struggling, not the request being wrong. */
const transient = (status: number) => status === 429 || status >= 500

/** A Retry-After value, in seconds or as an HTTP date, as milliseconds from now. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header?.trim()) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })

export interface PostOptions {
  url: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
  signal?: AbortSignal
  fetch: typeof fetch
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  now: () => number
}

/**
 * Sends one request, retrying when the service is limited or struggling. Resolves with the first response that is not
 * a transient failure, whatever its status, and rejects with JudgeUnavailable once retrying is spent.
 */
export async function post(options: PostOptions): Promise<Response> {
  const { signal } = options
  let spent = 0
  let response: Response
  for (let attempt = 0; ; attempt++) {
    const started = options.now()
    const timeout = AbortSignal.timeout(options.timeoutMs)
    let failure: string
    let retryAfter: number | undefined
    try {
      response = await options.fetch(options.url, {
        method: "POST",
        headers: options.headers,
        body: options.body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      spent += options.now() - started
      if (!transient(response.status)) break
      failure = `judge HTTP ${response.status}`
      retryAfter = retryAfterMs(response.headers.get("retry-after"))
      await response.body?.cancel()
    } catch (error) {
      if (signal?.aborted) throw error
      spent += options.now() - started
      failure = timeout.aborted ? `judge timed out after ${options.timeoutMs / 1000}s` : `judge unreachable: ${error instanceof Error ? error.message : String(error)}`
    }
    if (attempt >= RETRY_DELAYS_MS.length) throw new JudgeUnavailable(failure)
    const wait = retryAfter ?? RETRY_DELAYS_MS[attempt]!
    if (wait > MAX_RETRY_AFTER_MS || spent + wait > MAX_RETRY_TIME_MS) {
      throw new JudgeUnavailable(`${failure} (retry after ${Math.ceil(wait / 1000)}s)`)
    }
    spent += wait
    await options.sleep(wait, signal)
  }
  return response
}
