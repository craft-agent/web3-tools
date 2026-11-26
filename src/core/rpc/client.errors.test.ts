import { describe, expect, test } from "bun:test"
import { evmChain } from "../chains/evm"
import { RpcRefusal, evmClient } from "./client"
import {
  ALCHEMY_ENV,
  ALCHEMY_KEY,
  HELIUS_ENV,
  HELIUS_KEY,
  baseClient,
  clientsFor,
  rejection,
  toolError,
} from "./client.fixtures"
import { MASK } from "./mask"
import { fakeRpc, type FakeRpcHandler } from "./testing"

const BODY_LIMIT = 1024

function http(status: number, headers?: Record<string, string>, body: unknown = ""): FakeRpcHandler {
  return { http: { status, body, headers } }
}

describe("JsonRpcClient HTTP failures", () => {
  test("a redirect is upstream_error and is never followed", async () => {
    const { client, requests } = baseClient({ m: http(302, { location: "https://elsewhere.example/" }) })
    const error = await toolError(client.call("m"))

    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("Base (public endpoint) answered with a redirect, which is not followed.")
    expect(requests).toHaveLength(1)
  })

  test("429 is rate_limited with the wait from Retry-After and a hint to set the key on the public endpoint", async () => {
    const { client } = baseClient({ m: http(429, { "retry-after": "7" }) })
    const error = await toolError(client.call("m"))

    expect(error.code).toBe("rate_limited")
    expect(error.details).toEqual({ retry_after_s: 7 })
    expect(error.message).toContain("Base (public endpoint) is rate limiting calls (retry after 7 s).")
    expect(error.message).toContain("ALCHEMY_API_KEY")
  })

  test("429 without a usable Retry-After has no wait, and Solana's hint names HELIUS_API_KEY", async () => {
    for (const headers of [undefined, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, { "retry-after": "-3" }]) {
      const { fetch } = fakeRpc({ m: http(429, headers) })
      const error = await toolError(clientsFor(fetch, {}).solana.call("m"))

      expect(error.code).toBe("rate_limited")
      expect(error.details).toBeUndefined()
      expect(error.message).toContain("HELIUS_API_KEY")
    }
  })

  test("429 from a provider carries no hint to set the key", async () => {
    const { fetch } = fakeRpc({ m: http(429) })
    const error = await toolError(clientsFor(fetch, ALCHEMY_ENV).base.call("m"))

    expect(error.code).toBe("rate_limited")
    expect(error.message).toBe("Base (Alchemy) is rate limiting calls.")
  })

  test("401 and 403 from a provider mean the key is refused, naming its variable", async () => {
    for (const status of [401, 403]) {
      const { fetch } = fakeRpc({ m: http(status) })
      const { base, solana } = clientsFor(fetch, { ...ALCHEMY_ENV, ...HELIUS_ENV })

      const alchemy = await toolError(base.call("m"))
      expect(alchemy.code).toBe("unauthenticated")
      expect(alchemy.message).toBe("Base (Alchemy) refused the key in ALCHEMY_API_KEY.")
      expect((await toolError(solana.call("m"))).message).toBe("Solana (Helius) refused the key in HELIUS_API_KEY.")
    }
  })

  test("401 from the public endpoint is only upstream_error", async () => {
    const { client } = baseClient({ m: http(401) })
    const error = await toolError(client.call("m"))

    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("Base (public endpoint) answered HTTP 401.")
  })

  test("any other non-2xx status is upstream_error naming the status", async () => {
    const { client } = baseClient({ m: http(500, undefined, "boom") })
    const error = await toolError(client.call("m"))

    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("Base (public endpoint) answered HTTP 500.")
    expect(error.message).not.toContain("boom")
  })
})

describe("JsonRpcClient reply shape", () => {
  const notAReply = "Base (public endpoint) answered something that is not a JSON-RPC reply."

  test("a body that is not JSON, or has neither result nor error, is not a JSON-RPC reply", async () => {
    for (const body of ["<html>hi</html>", "", "[1]", "null", JSON.stringify({ jsonrpc: "2.0", id: 1 })]) {
      const { client } = baseClient({ m: { http: { body } } })
      const error = await toolError(client.call("m"))

      expect(error.code).toBe("upstream_error")
      expect(error.message).toBe(notAReply)
    }
  })

  test("an id that is not the request's is not a JSON-RPC reply", async () => {
    const { client } = baseClient({ m: { http: { body: { jsonrpc: "2.0", id: 99, result: 1 } } } })

    expect((await toolError(client.call("m"))).message).toBe(notAReply)
  })

  test("a body over the limit by Content-Length is refused unread", async () => {
    const { client } = baseClient(
      { m: http(200, { "content-length": "5000" }, JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 })) },
      { maxBytes: BODY_LIMIT },
    )
    const error = await toolError(client.call("m"))

    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("Base (public endpoint) answered with more than 1 KiB.")
  })

  test("a body that streams past the limit is cancelled once it is over", async () => {
    let cancelled = false
    const chunk = new TextEncoder().encode("x".repeat(600))
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(chunk),
      cancel: () => void (cancelled = true),
    })
    const { base } = clientsFor(() => Promise.resolve(new Response(body)), {}, { maxBytes: BODY_LIMIT })
    const error = await toolError(base.call("m"))

    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("Base (public endpoint) answered with more than 1 KiB.")
    expect(cancelled).toBe(true)
  })
})

describe("JsonRpcClient JSON-RPC errors", () => {
  test("an error the node answered with is an RpcRefusal with its code, message and data", async () => {
    const error = { code: -32000, message: "execution reverted", data: { reason: "no funds" } }
    const { client } = baseClient({ eth_call: { error } })
    const refusal = await rejection(client.call("eth_call"))

    expect(refusal).toBeInstanceOf(RpcRefusal)
    const { code, message, details, rpc } = refusal as RpcRefusal
    expect(code).toBe("upstream_error")
    expect(message).toBe("Base (public endpoint) refused eth_call: execution reverted")
    expect(details).toEqual({ rpc_code: -32000 })
    expect(rpc).toEqual(error)
  })

  test("a refusal message is cut to 300 characters, the rpc message is whole", async () => {
    const long = "y".repeat(500)
    const { client } = baseClient({ eth_call: { error: { code: 3, message: long } } })
    const refusal = (await rejection(client.call("eth_call"))) as RpcRefusal

    expect(refusal.message).toBe(`Base (public endpoint) refused eth_call: ${"y".repeat(300)}`)
    expect(refusal.rpc.message).toBe(long)
    expect("data" in refusal.rpc).toBe(false)
  })

  test("a method the node does not know is a refusal with -32601", async () => {
    const { client } = baseClient({})
    const refusal = (await rejection(client.call("eth_nope"))) as RpcRefusal

    expect(refusal).toBeInstanceOf(RpcRefusal)
    expect(refusal.rpc.code).toBe(-32601)
  })

  test("a provider key in a refusal is masked in the message and in rpc", async () => {
    const { fetch } = fakeRpc({
      m: {
        error: { code: -32000, message: `bad key ${ALCHEMY_KEY}`, data: { url: `https://h/?api-key=${HELIUS_KEY}` } },
      },
    })
    const { base } = clientsFor(fetch, { ...ALCHEMY_ENV, ...HELIUS_ENV })
    const refusal = (await rejection(base.call("m"))) as RpcRefusal

    expect(refusal.message).toBe(`Base (Alchemy) refused m: bad key ${MASK}`)
    expect(refusal.rpc.message).toBe(`bad key ${MASK}`)
    expect(refusal.rpc.data).toEqual({ url: `https://h/?api-key=${MASK}` })
    expect(JSON.stringify(refusal.rpc)).not.toContain(HELIUS_KEY)
    expect(JSON.stringify(refusal.rpc)).not.toContain(encodeURIComponent(HELIUS_KEY))
  })

  test("rate-limit codes and messages are rate_limited, not a refusal", async () => {
    const answers = [
      { code: -32005, message: "request rate limit exceeded" },
      { code: -32016, message: "over the limit" },
      { code: -32000, message: "Your app has exceeded its compute units per second capacity" },
      { code: 429, message: "slow down" },
      { code: -32000, message: "Too Many Requests" },
      { code: -32000, message: "daily Rate Limit reached" },
    ]
    for (const error of answers) {
      const { client } = baseClient({ m: { error } })
      const thrown = await toolError(client.call("m"))

      expect(thrown).not.toBeInstanceOf(RpcRefusal)
      expect(thrown.code).toBe("rate_limited")
      expect(thrown.message).toContain("ALCHEMY_API_KEY")
    }
  })

  test("-32005 without a rate-limit message is a refusal, as nodes also use it for too many results", async () => {
    const { client } = baseClient({
      eth_getLogs: { error: { code: -32005, message: "query returned more than 10000 results" } },
    })
    const refusal = await rejection(client.call("eth_getLogs"))

    expect(refusal).toBeInstanceOf(RpcRefusal)
    expect((refusal as RpcRefusal).rpc.code).toBe(-32005)
  })

  test("a chain no provider serves gets no hint to set a key", async () => {
    const { fetch } = fakeRpc({ m: http(429) })
    const error = await toolError(evmClient(evmChain("scroll-sepolia"), { fetch, env: ALCHEMY_ENV }).call("m"))

    expect(error.message).toBe("Scroll Sepolia (public endpoint) is rate limiting calls.")
  })
})

describe("JsonRpcClient leaks", () => {
  test("a network error whose message holds the URL and key says only its name", async () => {
    const reason = `request to https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)} failed`
    const failing = () =>
      Promise.reject(new TypeError(`${reason} via https://base-mainnet.g.alchemy.com/v2 ${ALCHEMY_KEY}`))
    const { base, solana } = clientsFor(failing, { ...ALCHEMY_ENV, ...HELIUS_ENV })

    for (const client of [base, solana]) {
      const error = await toolError(client.call("m"))
      const shown = [error.message, JSON.stringify(error.details ?? null), JSON.stringify(error)].join("\n")

      expect(error.code).toBe("upstream_error")
      expect(error.message).toMatch(/^(Base \(Alchemy\)|Solana \(Helius\)) could not be reached \(TypeError\)\.$/)
      expect(error.cause).toBeUndefined()
      for (const secret of [ALCHEMY_KEY, HELIUS_KEY, encodeURIComponent(HELIUS_KEY), "helius-rpc.com", "alchemy.com"]) {
        expect(shown).not.toContain(secret)
      }
    }
  })
})
