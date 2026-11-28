import type { EvmChain } from "../chains/evm"
import type { SolanaChain } from "../chains/solana"
import { ToolError, type ErrorCode, type ErrorDetails } from "../errors"
import { abortError } from "../exec"
import { isPlainObject, maskDeep, maskSecrets } from "./mask"
import {
  ALCHEMY_KEY_VARIABLE,
  HELIUS_KEY_VARIABLE,
  evmEndpoint,
  providerLabel,
  providerSecrets,
  solanaEndpoint,
  type Endpoint,
  type Env,
  type Provider,
} from "./providers"

/** The `fetch` the client calls through; tests pass a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** What a tool factory passes to reach a chain; tests inject both. */
export type RpcDeps = {
  /** Defaults to `globalThis.fetch`, read at call time. */
  readonly fetch?: FetchLike
  /** Where provider keys are read from; defaults to `process.env`, read at call time. */
  readonly env?: Env
}

export type ClientOptions = RpcDeps & {
  /** Cancels the call; the call then rejects with an `AbortError`. */
  readonly signal?: AbortSignal
  /** Defaults to `DEFAULT_TIMEOUT_MS`. */
  readonly timeoutMs?: number
  /** The most a reply body may hold, in bytes; defaults to `DEFAULT_MAX_BYTES`. */
  readonly maxBytes?: number
}

/** How long one call may wait for the node, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** The most a reply body may hold, in bytes. */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024

const MS_PER_SECOND = 1000
const BYTES_PER_KIB = 1024
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB
const HTTP_OK_MIN = 200
const HTTP_REDIRECT_MIN = 300
const HTTP_REDIRECT_MAX = 399
const HTTP_UNAUTHENTICATED = 401
const HTTP_FORBIDDEN = 403
const HTTP_RATE_LIMITED = 429
const OPAQUE_REDIRECT = "opaqueredirect"
const MAX_REFUSAL_CHARS = 300
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([-32016, 429])
const RATE_LIMIT_MESSAGE = /rate limit|too many requests|exceeded .*capacity/i
const DIGITS_PATTERN = /^\d+$/

/** A JSON-RPC error the node answered with; `rpc` holds its code, message and data, masked. */
export class RpcRefusal extends ToolError {
  readonly rpc: { readonly code: number; readonly message: string; readonly data?: unknown }

  constructor(message: string, rpc: { readonly code: number; readonly message: string; readonly data?: unknown }) {
    super("upstream_error", message, { details: { rpc_code: rpc.code } })
    this.rpc = rpc
  }
}

type RpcReply = Record<string, unknown>

function ignore(): void {}

function isRedirect(response: Response): boolean {
  const { status } = response
  const isRedirectStatus = status >= HTTP_REDIRECT_MIN && status <= HTTP_REDIRECT_MAX
  return isRedirectStatus || status === 0 || response.type === OPAQUE_REDIRECT
}

function discard(response: Response): Promise<void> | undefined {
  return response.body?.cancel().catch(ignore)
}

function describeBytes(bytes: number): string {
  if (bytes >= BYTES_PER_MIB) return `${Number((bytes / BYTES_PER_MIB).toFixed(2))} MiB`
  if (bytes >= BYTES_PER_KIB) return `${Number((bytes / BYTES_PER_KIB).toFixed(2))} KiB`
  return `${bytes} bytes`
}

function parseReply(text: string): RpcReply | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isPlainObject(parsed)) return undefined
  const hasError = parsed.error !== undefined && parsed.error !== null
  return hasError || "result" in parsed ? parsed : undefined
}

/** The one way a tool reaches a node: the endpoint of the chain table, no redirect, a time limit, mapped failures and masked text. */
export class JsonRpcClient {
  readonly provider: Provider
  readonly #name: string
  readonly #keyVariable: string | undefined
  readonly #endpoint: Endpoint
  readonly #options: ClientOptions
  readonly #secrets: string[]
  #nextId = 1

  constructor(
    target: {
      readonly name: string
      readonly endpoint: Endpoint
      /** The variable whose key would send this chain to a provider; absent when no provider serves it. */
      readonly keyVariable?: string
    },
    options: ClientOptions = {},
  ) {
    this.#name = target.name
    this.#keyVariable = target.keyVariable
    this.#endpoint = target.endpoint
    this.#options = options
    this.provider = target.endpoint.provider
    this.#secrets = providerSecrets(options.env)
  }

  /** The chain's name, for the messages of those who read through this client. */
  get name(): string {
    return this.#name
  }

  /**
   * Calls one JSON-RPC method and returns its `result`, every string masked. A failure throws a `ToolError`
   * (an error the node answered with is an `RpcRefusal`); a cancellation throws an `AbortError`.
   */
  async call<T = unknown>(method: string, params?: readonly unknown[] | Readonly<Record<string, unknown>>): Promise<T> {
    const callerSignal = this.#options.signal
    if (callerSignal?.aborted) throw abortError(callerSignal)
    const id = this.#nextId++
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal
    try {
      const send = this.#options.fetch ?? globalThis.fetch
      const response = await send(this.#endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...this.#endpoint.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? [] }),
        redirect: "manual",
        signal,
      })
      await this.#refuseStatus(response)
      const text = await this.#readBody(response, signal)
      return this.#unwrap<T>(text, id, method, response.headers.get("retry-after"))
    } catch (error) {
      if (callerSignal?.aborted) throw abortError(callerSignal)
      if (error instanceof ToolError) throw error
      if (timeout.signal.aborted) {
        throw this.#error("upstream_error", `${this.#label()} did not answer within ${timeoutMs / MS_PER_SECOND} s.`)
      }
      const reason = error instanceof Error ? error.name : "Error"
      throw this.#error("upstream_error", `${this.#label()} could not be reached (${reason}).`)
    } finally {
      clearTimeout(timer)
    }
  }

  #label(): string {
    return `${this.#name} (${providerLabel(this.provider)})`
  }

  #error(code: ErrorCode, message: string, details?: ErrorDetails): ToolError {
    return new ToolError(code, maskSecrets(message, this.#secrets), details && { details })
  }

  #notAReply(): ToolError {
    return this.#error("upstream_error", `${this.#label()} answered something that is not a JSON-RPC reply.`)
  }

  #rateLimited(retryAfter: string | null): ToolError {
    const wait = retryAfter?.trim()
    const seconds = wait && DIGITS_PATTERN.test(wait) ? Number(wait) : Number.NaN
    const hasWait = Number.isSafeInteger(seconds)
    const hint =
      this.provider === "public" && this.#keyVariable ? ` Set ${this.#keyVariable} to use a provider key.` : ""
    return this.#error(
      "rate_limited",
      `${this.#label()} is rate limiting calls${hasWait ? ` (retry after ${seconds} s)` : ""}.${hint}`,
      hasWait ? { retry_after_s: seconds } : undefined,
    )
  }

  async #refuseStatus(response: Response): Promise<void> {
    const { status } = response
    if (isRedirect(response)) {
      await discard(response)
      throw this.#error("upstream_error", `${this.#label()} answered with a redirect, which is not followed.`)
    }
    if (status >= HTTP_OK_MIN && status < HTTP_REDIRECT_MIN) return
    await discard(response)
    if (status === HTTP_RATE_LIMITED) throw this.#rateLimited(response.headers.get("retry-after"))
    const isRefusedKey = status === HTTP_UNAUTHENTICATED || status === HTTP_FORBIDDEN
    if (isRefusedKey && this.provider !== "public") {
      throw this.#error(
        "unauthenticated",
        `${this.#label()} refused the key in ${this.#keyVariable ?? "its variable"}.`,
      )
    }
    throw this.#error("upstream_error", `${this.#label()} answered HTTP ${status}.`)
  }

  #tooLarge(maxBytes: number): ToolError {
    return this.#error("upstream_error", `${this.#label()} answered with more than ${describeBytes(maxBytes)}.`)
  }

  async #readBody(response: Response, signal: AbortSignal): Promise<string> {
    const maxBytes = this.#options.maxBytes ?? DEFAULT_MAX_BYTES
    const declared = response.headers.get("content-length")?.trim()
    if (declared && DIGITS_PATTERN.test(declared) && Number(declared) > maxBytes) {
      await discard(response)
      throw this.#tooLarge(maxBytes)
    }
    if (!response.body) return ""
    const reader = response.body.getReader()
    const cancel = () => void reader.cancel().catch(ignore)
    signal.addEventListener("abort", cancel, { once: true })
    try {
      if (signal.aborted) cancel()
      const decoder = new TextDecoder()
      let text = ""
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (signal.aborted) throw abortError(signal)
        if (done) return text + decoder.decode()
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(ignore)
          throw this.#tooLarge(maxBytes)
        }
        text += decoder.decode(value, { stream: true })
      }
    } finally {
      signal.removeEventListener("abort", cancel)
    }
  }

  #unwrap<T>(text: string, id: number, method: string, retryAfter: string | null): T {
    const reply = parseReply(text)
    if (!reply || reply.id !== id) throw this.#notAReply()
    const failure = reply.error
    if (failure === undefined || failure === null) return maskDeep(reply.result as T, this.#secrets)
    if (!isPlainObject(failure)) throw this.#notAReply()
    const code = typeof failure.code === "number" && Number.isFinite(failure.code) ? failure.code : 0
    const message = maskSecrets(typeof failure.message === "string" ? failure.message : "", this.#secrets)
    if (RATE_LIMIT_CODES.has(code) || RATE_LIMIT_MESSAGE.test(message)) throw this.#rateLimited(retryAfter)
    const reason = message ? `: ${message.slice(0, MAX_REFUSAL_CHARS)}` : "."
    throw new RpcRefusal(maskSecrets(`${this.#label()} refused ${method}${reason}`, this.#secrets), {
      code,
      message,
      ...(failure.data === undefined ? {} : { data: maskDeep(failure.data, this.#secrets) }),
    })
  }
}

/** A client for an EVM chain, through Alchemy when `ALCHEMY_API_KEY` is set and serves it, else the public endpoint. */
export function evmClient(chain: EvmChain, options: ClientOptions = {}): JsonRpcClient {
  return new JsonRpcClient(
    {
      name: chain.name,
      endpoint: evmEndpoint(chain, options.env),
      ...(chain.alchemy === undefined ? {} : { keyVariable: ALCHEMY_KEY_VARIABLE }),
    },
    options,
  )
}

/** A client for a Solana cluster, through Helius when `HELIUS_API_KEY` is set, else the public endpoint. */
export function solanaClient(chain: SolanaChain, options: ClientOptions = {}): JsonRpcClient {
  return new JsonRpcClient(
    { name: chain.name, endpoint: solanaEndpoint(chain, options.env), keyVariable: HELIUS_KEY_VARIABLE },
    options,
  )
}
