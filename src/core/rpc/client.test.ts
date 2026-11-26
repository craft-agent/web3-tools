import { describe, expect, test } from "bun:test"
import { MASK } from "./mask"
import { ALCHEMY_ENV, ALCHEMY_KEY, HELIUS_ENV, HELIUS_KEY, baseClient, clientsFor } from "./client.fixtures"
import { fakeRpc } from "./testing"

describe("JsonRpcClient request", () => {
  test("posts a JSON-RPC 2.0 body to the public endpoint, params defaulting to []", async () => {
    const { client, requests } = baseClient({ eth_blockNumber: { result: "0x10" } })
    const result = await client.call("eth_blockNumber")

    expect(result).toBe("0x10")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: "https://mainnet.base.org",
      method: "eth_blockNumber",
      params: [],
      id: 1,
    })
    expect(requests[0]!.headers["content-type"]).toBe("application/json")
    expect(requests[0]!.headers.accept).toBe("application/json")
    expect(requests[0]!.headers.authorization).toBeUndefined()
  })

  test("sends the params it is given, an array or an object", async () => {
    const { fetch, requests } = fakeRpc({ eth_getBalance: { result: "0x0" }, getAccountInfo: { result: null } })
    const { base, solana } = clientsFor(fetch, {})
    await base.call("eth_getBalance", ["0xabc", "latest"])
    await solana.call("getAccountInfo", { pubkey: "x" })

    expect(requests.map((request) => request.params)).toEqual([["0xabc", "latest"], { pubkey: "x" }])
  })

  test("ids count up from 1 for each client", async () => {
    const { fetch, requests } = fakeRpc({ a: { result: 1 } })
    const first = clientsFor(fetch, {}).base
    await first.call("a")
    await first.call("a")
    await clientsFor(fetch, {}).base.call("a")

    expect(requests.map((request) => request.id)).toEqual([1, 2, 1])
  })

  test("Alchemy gets the key as a bearer token and a URL without it", async () => {
    const { fetch, requests } = fakeRpc({ eth_chainId: { result: "0x2105" } })
    await clientsFor(fetch, ALCHEMY_ENV).base.call("eth_chainId")

    expect(requests[0]!.url).toBe("https://base-mainnet.g.alchemy.com/v2")
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${ALCHEMY_KEY}`)
  })

  test("Helius gets the key in the URL and no authorization header", async () => {
    const { fetch, requests } = fakeRpc({ getSlot: { result: 5 } })
    const { solana } = clientsFor(fetch, HELIUS_ENV)
    await solana.call("getSlot")

    expect(solana.provider).toBe("helius")
    expect(requests[0]!.url).toBe(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)}`)
    expect(requests[0]!.headers.authorization).toBeUndefined()
  })

  test("never follows a redirect", async () => {
    let init: RequestInit | undefined
    const { base } = clientsFor((_url, received) => {
      init = received
      return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: 1 }))
    }, {})
    await base.call("a")

    expect(init?.redirect).toBe("manual")
    expect(init?.method).toBe("POST")
  })
})

describe("JsonRpcClient result", () => {
  test("returns the result as the node sent it", async () => {
    const result = { number: "0x1", transactions: [{ hash: "0xabc" }], nothing: null }
    const { client } = baseClient({ eth_getBlockByNumber: { result } })

    expect(await client.call("eth_getBlockByNumber", ["0x1", true])).toEqual(result)
  })

  test("masks a provider key in every string of the result, keys included", async () => {
    const { fetch } = fakeRpc({
      note: { result: { url: `https://x/?k=${ALCHEMY_KEY}`, list: [HELIUS_KEY], [ALCHEMY_KEY]: 1 } },
    })
    const { base } = clientsFor(fetch, { ...ALCHEMY_ENV, ...HELIUS_ENV })
    const result = await base.call<Record<string, unknown>>("note")

    expect(JSON.stringify(result)).not.toContain(ALCHEMY_KEY)
    expect(JSON.stringify(result)).not.toContain(HELIUS_KEY)
    expect(result).toEqual({ url: `https://x/?k=${MASK}`, list: [MASK], [MASK]: 1 })
  })
})
