import { describe, expect, test } from "bun:test"
import { baseClient, toolError } from "../rpc/client.fixtures"
import { hasCode, latestBaseFee, nativeBalance, priorityFee, transactionCount } from "./reads"
import { FakeEvmChain } from "./testing"

const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
const GWEI = 10n ** 9n

describe("nativeBalance and transactionCount", () => {
  test("read the balance and the mined nonce from the node", async () => {
    const chain = new FakeEvmChain("base").setBalance(ALICE, 12_345n).setNonce(ALICE, 7n)
    const client = chain.client()
    expect(await nativeBalance(client, ALICE)).toBe(12_345n)
    expect(await nativeBalance(client, CONTRACT)).toBe(0n)
    expect(await transactionCount(client, ALICE, "latest")).toBe(7n)
    expect(chain.requestsOf("eth_getBalance")[0]).toEqual([ALICE, "latest"])
    expect(chain.requestsOf("eth_getTransactionCount")[0]).toEqual([ALICE, "latest"])
  })

  test("ask for the pending count when told to", async () => {
    const chain = new FakeEvmChain("base")
    await transactionCount(chain.client(), ALICE, "pending")
    expect(chain.requestsOf("eth_getTransactionCount")[0]).toEqual([ALICE, "pending"])
  })

  test("an answer that is not a plain hex quantity is upstream_error naming the chain", async () => {
    for (const result of ["0x", "12", "0x01", "0xZZ", 5, null, `0x${"f".repeat(65)}`]) {
      const { client } = baseClient({ eth_getBalance: { result }, eth_getTransactionCount: { result } })
      for (const read of [nativeBalance(client, ALICE), transactionCount(client, ALICE, "latest")]) {
        const error = await toolError(read)
        expect(error.code).toBe("upstream_error")
        expect(error.message).toContain("Base")
      }
    }
  })

  test("the largest word and zero are quantities", async () => {
    const { client } = baseClient({ eth_getBalance: { result: `0x${"f".repeat(64)}` } })
    expect(await nativeBalance(client, ALICE)).toBe(2n ** 256n - 1n)
    expect(await nativeBalance(baseClient({ eth_getBalance: { result: "0x0" } }).client, ALICE)).toBe(0n)
  })
})

describe("hasCode", () => {
  test("is true for a contract and false for an account", async () => {
    const client = new FakeEvmChain("base").addContract(CONTRACT).client()
    expect(await hasCode(client, CONTRACT)).toBe(true)
    expect(await hasCode(client, ALICE)).toBe(false)
  })

  test("an answer that is not code is upstream_error", async () => {
    for (const result of ["0x1", "nope", null]) {
      const { client } = baseClient({ eth_getCode: { result } })
      expect((await toolError(hasCode(client, ALICE))).code).toBe("upstream_error")
    }
  })
})

describe("latestBaseFee", () => {
  test("is the latest block's base fee, and asks for hashes only", async () => {
    const chain = new FakeEvmChain("base", { baseFee: 3n * GWEI })
    expect(await latestBaseFee(chain.client())).toBe(3n * GWEI)
    expect(chain.requestsOf("eth_getBlockByNumber")[0]).toEqual(["latest", false])
  })

  test("is 0 for a block without one", async () => {
    expect(await latestBaseFee(new FakeEvmChain("base", { baseFee: undefined }).client())).toBe(0n)
  })

  test("a block that is not one, or a base fee that is not a quantity, is upstream_error", async () => {
    for (const result of [null, "0x1", { baseFeePerGas: "12" }]) {
      const { client } = baseClient({ eth_getBlockByNumber: { result } })
      const error = await toolError(latestBaseFee(client))
      expect(error.code).toBe("upstream_error")
      expect(error.message).toContain("Base")
    }
  })
})

describe("priorityFee", () => {
  test("is what eth_maxPriorityFeePerGas answers", async () => {
    const chain = new FakeEvmChain("base", { priorityFee: 5n * GWEI })
    expect(await priorityFee(chain.client())).toBe(5n * GWEI)
    expect(chain.requestsOf("eth_gasPrice")).toHaveLength(0)
  })

  test("falls back to the gas price less the base fee where the method is not found", async () => {
    const chain = new FakeEvmChain("base", { priorityFee: "unsupported", baseFee: 4n * GWEI, gasPrice: 7n * GWEI })
    expect(await priorityFee(chain.client())).toBe(3n * GWEI)
  })

  test("falls back on a message that says the method is not supported", async () => {
    const { client } = baseClient({
      eth_maxPriorityFeePerGas: {
        error: { code: -32000, message: "the method eth_maxPriorityFeePerGas does not exist/is not available" },
      },
      eth_gasPrice: { result: "0x64" },
      eth_getBlockByNumber: { result: {} },
    })
    expect(await priorityFee(client)).toBe(100n)
  })

  test("the fallback is floored at 0", async () => {
    const chain = new FakeEvmChain("base", { priorityFee: "unsupported", baseFee: 9n * GWEI, gasPrice: 2n * GWEI })
    expect(await priorityFee(chain.client())).toBe(0n)
  })

  test("any other refusal propagates, and so does a malformed answer", async () => {
    const refused = baseClient({ eth_maxPriorityFeePerGas: { error: { code: -32000, message: "boom" } } })
    expect((await toolError(priorityFee(refused.client))).message).toContain("boom")
    const malformed = baseClient({ eth_maxPriorityFeePerGas: { result: "fast" } })
    expect((await toolError(priorityFee(malformed.client))).code).toBe("upstream_error")
    expect(malformed.requests.map((request) => request.method)).toEqual(["eth_maxPriorityFeePerGas"])
  })
})
