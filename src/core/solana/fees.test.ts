import { describe, expect, test } from "bun:test"
import { toolError } from "../rpc/client.fixtures"
import { capSolanaFees, MAX_UNIT_LIMIT, quoteSolanaFees, solanaFeeShortfall, type SolanaFeeQuote } from "./fees"
import { nodeClient, transferMessage } from "./reads.fixtures"
import { testAddress } from "./testing"
import { FakeSolanaCluster } from "./testing.cluster"

const ALICE = testAddress(1)
const BOB = testAddress(2)
const BLOCKHASH = new FakeSolanaCluster().latestBlockhash

/** A node that simulates every message as consuming `unitsConsumed` and reports `prices` as recent fees. */
function node(unitsConsumed: number, prices: number[]) {
  return nodeClient({
    simulateTransaction: { result: { value: { err: null, logs: [], unitsConsumed } } },
    getRecentPrioritizationFees: { result: prices.map((prioritizationFee, slot) => ({ slot, prioritizationFee })) },
  })
}

const build = (budget: Parameters<typeof transferMessage>[4]) => transferMessage(BLOCKHASH, ALICE, BOB, 1n, budget)

async function quoteOf(unitsConsumed: number, prices: number[]): Promise<SolanaFeeQuote> {
  return quoteSolanaFees(node(unitsConsumed, prices).client, build, [ALICE, BOB])
}

describe("quoteSolanaFees: the compute unit limit", () => {
  test("is the units consumed and a tenth more, rounded up", async () => {
    expect((await quoteOf(200_000, [])).unitLimit).toBe(220_000)
    expect((await quoteOf(100_001, [])).unitLimit).toBe(110_002)
    expect((await quoteOf(12_345, [])).unitLimit).toBe(13_580)
  })

  test("is at least the units consumed and 300 more, for the two budget instructions", async () => {
    expect((await quoteOf(450, [])).unitLimit).toBe(750)
    expect((await quoteOf(2_500, [])).unitLimit).toBe(2_800)
    expect((await quoteOf(3_000, [])).unitLimit).toBe(3_300)
    expect((await quoteOf(3_001, [])).unitLimit).toBe(3_302)
  })

  test("is at most 1.4 million", async () => {
    expect((await quoteOf(1_390_000, [])).unitLimit).toBe(MAX_UNIT_LIMIT)
    expect((await quoteOf(MAX_UNIT_LIMIT, [])).unitLimit).toBe(MAX_UNIT_LIMIT)
  })

  test("is read from a simulation that sets the most units and a price of 0", async () => {
    const budgets: unknown[] = []
    const { client, requests } = node(1_000, [50])
    await quoteSolanaFees(
      client,
      (budget) => {
        budgets.push(budget)
        return build(budget)
      },
      [ALICE],
    )
    expect(budgets).toEqual([{ unitLimit: 1_400_000, unitPrice: 0n }])
    expect(requests.map((request) => request.method).sort()).toEqual([
      "getRecentPrioritizationFees",
      "simulateTransaction",
    ])
    expect(requests.find((request) => request.method === "getRecentPrioritizationFees")?.params).toEqual([[ALICE]])
  })
})

describe("quoteSolanaFees: the price", () => {
  test("is the 75th percentile of the non-zero prices, by nearest rank", async () => {
    expect((await quoteOf(200_000, [0, 100, 200, 300, 400])).unitPrice).toBe(300n)
    expect((await quoteOf(200_000, [500, 100, 300, 200, 400])).unitPrice).toBe(400n)
    expect((await quoteOf(200_000, [700])).unitPrice).toBe(700n)
    expect((await quoteOf(200_000, [10, 20])).unitPrice).toBe(20n)
    expect((await quoteOf(200_000, [10, 20, 30])).unitPrice).toBe(30n)
    expect((await quoteOf(200_000, [5, 5, 5, 9_000_000_000])).unitPrice).toBe(5n)
  })

  test("is 0 when no block paid a price, and the zeros do not pull a price down", async () => {
    expect((await quoteOf(200_000, [])).unitPrice).toBe(0n)
    expect((await quoteOf(200_000, [0, 0, 0])).unitPrice).toBe(0n)
    expect((await quoteOf(200_000, [0, 0, 0, 0, 0, 0, 800])).unitPrice).toBe(800n)
  })
})

describe("quoteSolanaFees: needed and suggested", () => {
  test("needed is the signature fee and the priority fee on the limit, rounded up", async () => {
    const quote = await quoteOf(200_000, [10_000])
    expect(quote).toMatchObject({ unitsConsumed: 200_000, unitLimit: 220_000, unitPrice: 10_000n, baseFee: 5000n })
    expect(quote.needed).toBe(5000n + 2200n)
    expect((await quoteOf(200_000, [1])).needed).toBe(5000n + 1n)
    expect((await quoteOf(200_000, [4_545])).needed).toBe(5000n + 1000n)
    expect((await quoteOf(200_000, [4_546])).needed).toBe(5000n + 1001n)
  })

  test("suggested is the signature fee and the priority fee at twice the price", async () => {
    const quote = await quoteOf(200_000, [10_000])
    expect(quote.suggested).toBe(5000n + 4400n)
    expect(quote.cluster).toBe("Solana")
  })

  test("with no recent price suggested still leaves room: a price of 1000 micro-lamports a unit", async () => {
    const quote = await quoteOf(200_000, [])
    expect(quote.needed).toBe(5000n)
    expect(quote.suggested).toBe(5000n + 220n)
    expect((await quoteOf(450, [])).suggested).toBe(5000n + 1n)
  })

  test("a low recent price is lifted to that floor in suggested, and a high one is doubled", async () => {
    expect((await quoteOf(200_000, [100])).suggested).toBe(5000n + 220n)
    expect((await quoteOf(200_000, [500])).suggested).toBe(5000n + 220n)
    expect((await quoteOf(200_000, [501])).suggested).toBe(5000n + 221n)
  })
})

describe("quoteSolanaFees: through a cluster", () => {
  test("simulates the message the fake would run and quotes its units and the fees it holds", async () => {
    const cluster = new FakeSolanaCluster().setBalance(ALICE, 10_000_000n)
    cluster.priorityFees = [0n, 2_000n, 4_000n, 6_000n]
    const quote = await quoteSolanaFees(
      cluster.client(),
      (budget) => transferMessage(cluster.latestBlockhash, ALICE, BOB, 1_000_000n, budget),
      [ALICE, BOB],
    )
    expect(quote).toMatchObject({ unitsConsumed: 450, unitLimit: 750, unitPrice: 6_000n, cluster: "Solana" })
    expect(cluster.balanceOf(ALICE)).toBe(10_000_000n)
  })

  test("a message the cluster would fail is invalid_argument, and nothing is quoted", async () => {
    const cluster = new FakeSolanaCluster().setBalance(ALICE, 6_000n)
    const error = await toolError(
      quoteSolanaFees(
        cluster.client(),
        (budget) => transferMessage(cluster.latestBlockhash, ALICE, BOB, 5_000n, budget),
        [ALICE],
      ),
    )
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("The cluster would fail this transaction")
  })

  test("a message that cannot be compiled is invalid_argument before any request", async () => {
    const { client, requests } = node(1_000, [])
    const error = await toolError(quoteSolanaFees(client, () => transferMessage("short", ALICE, BOB, 1n), [ALICE]))
    expect(error.code).toBe("invalid_argument")
    expect(requests).toHaveLength(0)
  })
})

describe("capSolanaFees", () => {
  const quote: SolanaFeeQuote = {
    cluster: "Solana",
    unitsConsumed: 200_000,
    unitLimit: 220_000,
    unitPrice: 10_000n,
    baseFee: 5000n,
    needed: 7200n,
    suggested: 9400n,
  }

  test("a max_fee below what the cluster asks now is stale, naming the cluster and both figures", () => {
    for (const maxFee of [0n, 5000n, 7199n]) {
      let thrown: unknown
      try {
        capSolanaFees(quote, maxFee)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toMatchObject({ code: "stale" })
      expect((thrown as Error).message).toContain("Solana")
      expect((thrown as Error).message).toContain("at least 7200 lamports")
      expect((thrown as Error).message).toContain(`max_fee is ${maxFee}`)
      expect((thrown as Error).message).toContain("Nothing was sent")
    }
  })

  test("a max_fee of exactly what is needed signs the quoted price, with the quoted limit", () => {
    expect(capSolanaFees(quote, 7200n)).toEqual({ unitLimit: 220_000, unitPrice: 10_000n })
  })

  test("a max_fee with room signs the largest price that fits it, never above twice the quoted price", () => {
    expect(capSolanaFees(quote, 8000n).unitPrice).toBe(13_636n)
    expect(capSolanaFees(quote, 9400n).unitPrice).toBe(20_000n)
    expect(capSolanaFees(quote, 10n ** 12n).unitPrice).toBe(20_000n)
  })

  test("the fee of the capped price is within max_fee and the next price up would not be", () => {
    for (let maxFee = 7200n; maxFee < 9400n; maxFee += 37n) {
      const { unitPrice, unitLimit } = capSolanaFees(quote, maxFee)
      const fee = (price: bigint) => 5000n + (price * BigInt(unitLimit) + 999_999n) / 1_000_000n
      expect(fee(unitPrice)).toBeLessThanOrEqual(maxFee)
      expect(fee(unitPrice + 1n)).toBeGreaterThan(maxFee)
    }
  })

  test("with no recent price the price is 0 whatever the max_fee", () => {
    const free: SolanaFeeQuote = { ...quote, unitPrice: 0n, needed: 5000n, suggested: 5220n }
    expect(capSolanaFees(free, 5000n).unitPrice).toBe(0n)
    expect(capSolanaFees(free, 10n ** 9n).unitPrice).toBe(0n)
  })
})

describe("solanaFeeShortfall", () => {
  const quote: SolanaFeeQuote = {
    cluster: "Solana",
    unitsConsumed: 200_000,
    unitLimit: 220_000,
    unitPrice: 10_000n,
    baseFee: 5000n,
    needed: 7200n,
    suggested: 9400n,
  }

  test("is undefined for a max_fee that is enough", () => {
    expect(solanaFeeShortfall(quote, 7200n)).toBeUndefined()
    expect(solanaFeeShortfall(quote, 10n ** 12n)).toBeUndefined()
  })

  test("is invalid_argument naming what is needed, what is suggested and the cluster, in lamports", () => {
    const error = solanaFeeShortfall(quote, 7199n)
    expect(error?.code).toBe("invalid_argument")
    expect(error?.message).toBe(
      "max_fee 7199 lamports is below the 7200 lamports the network asks now on Solana; 9400 lamports leaves room for the fee to rise.",
    )
  })
})
