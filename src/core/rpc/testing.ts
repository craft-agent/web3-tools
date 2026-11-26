import { abortError } from "../exec"
import type { FetchLike } from "./client"

const METHOD_NOT_FOUND = { code: -32601, message: "Method not found" }

/** A call the fake received, with lowercased header names and the JSON body parsed. */
export type FakeRpcRequest = {
  url: string
  headers: Record<string, string>
  id: unknown
  method: string
  params: unknown
}

/** What the fake answers: a JSON-RPC `result` or `error`, or a raw HTTP response (a string `body` is sent as it is, anything else as JSON). */
export type FakeRpcAnswer =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
  | { http: { status?: number; body?: unknown; headers?: Record<string, string> } }

/** An answer, or a function that makes one from the request. */
export type FakeRpcHandler = FakeRpcAnswer | ((request: FakeRpcRequest) => FakeRpcAnswer | Promise<FakeRpcAnswer>)

function toRequest(url: string, init: RequestInit): FakeRpcRequest {
  const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<string, unknown>
  return {
    url,
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    id: body.id,
    method: String(body.method),
    params: body.params,
  }
}

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal))
      return
    }
    signal.addEventListener("abort", () => reject(abortError(signal)), { once: true })
    pending.then(resolve, reject)
  })
}

function toResponse(answer: FakeRpcAnswer, id: unknown): Response {
  if (!("http" in answer)) return Response.json({ jsonrpc: "2.0", id, ...answer })
  const { status = 200, body, headers } = answer.http
  const isText = typeof body === "string"
  const payload = body === undefined ? null : isText ? body : JSON.stringify(body)
  return new Response(payload, {
    status,
    headers: { ...(payload !== null && !isText ? { "content-type": "application/json" } : {}), ...headers },
  })
}

/**
 * A stand-in for any JSON-RPC endpoint: answers by method, records every request,
 * honors `init.signal` also while a handler is still pending, and answers -32601 to an unknown method.
 */
export function fakeRpc(methods: Record<string, FakeRpcHandler>): { fetch: FetchLike; requests: FakeRpcRequest[] } {
  const requests: FakeRpcRequest[] = []
  const fetch: FetchLike = async (url, init) => {
    const request = toRequest(url, init)
    requests.push(request)
    const handler = Object.hasOwn(methods, request.method) ? methods[request.method] : undefined
    const answer: FakeRpcAnswer =
      handler === undefined
        ? { error: METHOD_NOT_FOUND }
        : typeof handler === "function"
          ? await untilAborted(Promise.resolve(handler(request)), init.signal)
          : handler
    if (init.signal?.aborted) throw abortError(init.signal)
    return toResponse(answer, request.id)
  }
  return { fetch, requests }
}
