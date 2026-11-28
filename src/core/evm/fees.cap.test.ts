import { describe, expect, test } from "bun:test"
import { isToolError } from "../errors"
import { capFees, feeShortfall, quoteFees, type FeeQuote } from "./fees"
import { FakeEvmChain } from "./testing"

const QUOTE: FeeQuote = {
  chain: "Base",
  gasLimit: 100n,
  baseFee: 10n,
  priorityFee: 3n,
  maxFeePerGas: 23n,
  l1Fee: 200n,
  operatorFee: 50n,
  needed: 100n * 13n + 250n,
  suggested: 100n * 23n + 250n,
}

describe("capFees", () => {
  test("a max_fee below what the network asks is stale, saying so and that nothing was sent", () => {
    try {
      capFees(QUOTE, 1_549n)
    } catch (error) {
      expect(isToolError(error) && error.code).toBe("stale")
      expect((error as Error).message).toBe(
        "Network fees on Base now need at least 1550 wei; max_fee is 1549. Nothing was sent.",
      )
      return
    }
    throw new Error("expected a stale refusal")
  })

  test("at exactly what the network asks it signs with the current fees", () => {
    expect(capFees(QUOTE, 1_550n)).toEqual({ maxFeePerGas: 13n, maxPriorityFeePerGas: 3n })
  })

  test("between that and the suggestion it gives the L1 and operator fees first, then the rest per gas, rounded down", () => {
    expect(capFees(QUOTE, 1_999n)).toEqual({ maxFeePerGas: 17n, maxPriorityFeePerGas: 3n })
    expect(capFees(QUOTE, 2_549n)).toEqual({ maxFeePerGas: 22n, maxPriorityFeePerGas: 3n })
  })

  test("at the suggestion, or above, it never goes past the quote's own maxFeePerGas", () => {
    expect(capFees(QUOTE, 2_550n)).toEqual({ maxFeePerGas: 23n, maxPriorityFeePerGas: 3n })
    expect(capFees(QUOTE, 10n ** 30n)).toEqual({ maxFeePerGas: 23n, maxPriorityFeePerGas: 3n })
  })

  test("the priority fee never exceeds the max fee per gas", () => {
    const tipHeavy: FeeQuote = { ...QUOTE, baseFee: 0n, priorityFee: 20n, maxFeePerGas: 20n, needed: 100n * 20n + 250n }
    expect(capFees(tipHeavy, tipHeavy.needed)).toEqual({ maxFeePerGas: 20n, maxPriorityFeePerGas: 20n })
  })

  test("what it signs never costs more than max_fee, whatever max_fee is", () => {
    for (let maxFee = QUOTE.needed; maxFee <= QUOTE.suggested + 150n; maxFee += 7n) {
      const { maxFeePerGas, maxPriorityFeePerGas } = capFees(QUOTE, maxFee)
      expect(QUOTE.gasLimit * maxFeePerGas + QUOTE.l1Fee + QUOTE.operatorFee).toBeLessThanOrEqual(maxFee)
      expect(maxFeePerGas).toBeGreaterThanOrEqual(QUOTE.baseFee + QUOTE.priorityFee)
      expect(maxPriorityFeePerGas).toBeLessThanOrEqual(maxFeePerGas)
    }
  })

  test("takes a quote from quoteFees: the quote's suggested max_fee passes with its own fees", async () => {
    const from = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
    const fake = new FakeEvmChain("base", {
      baseFee: 10n,
      priorityFee: 3n,
      oracle: { l1Fee: 1_000n, operatorFee: 500n, tokenRatio: 1n },
    }).setBalance(from, 10n ** 18n)
    const call = { from, to: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", value: 1n, data: "0x" }
    const quote = await quoteFees(fake.client(), fake.chain, call, 0n)
    expect(capFees(quote, quote.suggested)).toEqual({
      maxFeePerGas: quote.maxFeePerGas,
      maxPriorityFeePerGas: quote.priorityFee,
    })
    expect(capFees(quote, quote.needed).maxFeePerGas).toBe(quote.baseFee + quote.priorityFee)
  })
})

describe("feeShortfall", () => {
  test("is undefined when max_fee is what the network asks, or more", () => {
    expect(feeShortfall(QUOTE, QUOTE.needed)).toBeUndefined()
    expect(feeShortfall(QUOTE, QUOTE.suggested * 10n)).toBeUndefined()
  })

  test("is the invalid_argument refusal below it, naming the needed and the suggested max_fee", () => {
    const refusal = feeShortfall(QUOTE, 1_000n)
    expect(refusal?.code).toBe("invalid_argument")
    expect(refusal?.message).toBe(
      "max_fee 1000 wei is below the 1550 wei the network asks now on Base; 2550 wei leaves room for the fee to rise.",
    )
  })
})
