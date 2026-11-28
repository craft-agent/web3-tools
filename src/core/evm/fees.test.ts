import { describe, expect, test } from "bun:test"
import { evmChain, FEE_ORACLES } from "../chains/evm"
import { toolError } from "../rpc/client.fixtures"
import { word } from "./abi"
import { quoteFees, type EvmCall } from "./fees"
import { FakeEvmChain, type FakeEvmOptions } from "./testing"
import { placeholderSignedEvmTransactionHex, unsignedEvmTransactionHex } from "./transaction"
import { getL1FeeCall } from "./views"

const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
const SEND: EvmCall = { from: ALICE, to: BOB, value: 1_000n, data: "0x" }
const MARKET: FakeEvmOptions = { baseFee: 10n, priorityFee: 3n, contractGas: 100_000n }

function fakeOf(chain: string, options: FakeEvmOptions = {}): FakeEvmChain {
  return new FakeEvmChain(chain, { ...MARKET, ...options }).setBalance(ALICE, 10n ** 18n)
}

async function quote(fake: FakeEvmChain, call = SEND, nonce = 4n) {
  return quoteFees(fake.client(), fake.chain, call, nonce)
}

describe("quoteFees: gas", () => {
  test("a plain transfer keeps its exact 21000 and has no data fees", async () => {
    const fake = fakeOf("ethereum")
    expect(await quote(fake)).toEqual({
      chain: "Ethereum",
      gasLimit: 21_000n,
      baseFee: 10n,
      priorityFee: 3n,
      maxFeePerGas: 23n,
      l1Fee: 0n,
      operatorFee: 0n,
      needed: 21_000n * 13n,
      suggested: 21_000n * 23n,
    })
    expect(fake.requestsOf("eth_call")).toHaveLength(0)
    expect(fake.requestsOf("eth_estimateGas")[0]).toEqual([{ from: ALICE, to: BOB, value: "0x3e8", data: "0x" }])
  })

  test("any other estimate is raised by 20% and rounded up", async () => {
    const cases: [bigint, bigint][] = [
      [100_000n, 120_000n],
      [100_001n, 120_002n],
      [21_001n, 25_202n],
      [21_000n, 21_000n],
    ]
    for (const [estimate, gasLimit] of cases) {
      const fake = fakeOf("ethereum", { contractGas: estimate })
      const result = await quote(fake, { ...SEND, data: "0x01" })
      expect(result.gasLimit).toBe(gasLimit)
      expect(result.needed).toBe(gasLimit * 13n)
      expect(result.suggested).toBe(gasLimit * 23n)
    }
  })

  test("a chain without a base fee quotes the tip alone, on a node without eth_maxPriorityFeePerGas too", async () => {
    const fake = fakeOf("ethereum", { baseFee: undefined, priorityFee: "unsupported", gasPrice: 9n })
    const result = await quote(fake)
    expect(result).toMatchObject({ baseFee: 0n, priorityFee: 9n, maxFeePerGas: 9n, needed: 21_000n * 9n })
  })

  test("a call the chain would revert is invalid_argument with its reason, quoting nothing", async () => {
    const fake = fakeOf("ethereum")
    fake.estimateRevert = "paused"
    const error = await toolError(quote(fake))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain('"execution reverted: paused"')
  })

  test("an estimate below a plain transfer's gas is upstream_error", async () => {
    const fake = fakeOf("ethereum")
    fake.inject("eth_estimateGas", { result: "0x64" })
    expect((await toolError(quote(fake))).code).toBe("upstream_error")
  })
})

describe("quoteFees: linea", () => {
  const linea = { gasLimit: 53_000n, baseFeePerGas: 7n, priorityFeePerGas: 2n }

  test("takes the gas limit and fees of linea_estimateGas as they are", async () => {
    const fake = fakeOf("linea", { linea })
    const result = await quote(fake)
    expect(result).toMatchObject({
      gasLimit: 53_000n,
      baseFee: 7n,
      priorityFee: 2n,
      maxFeePerGas: 16n,
      l1Fee: 0n,
      operatorFee: 0n,
      needed: 53_000n * 9n,
      suggested: 53_000n * 16n,
    })
    expect(fake.requestsOf("linea_estimateGas")).toEqual([[{ from: ALICE, to: BOB, value: "0x3e8", data: "0x" }]])
    expect(fake.requests.map((request) => request.method)).toEqual(["linea_estimateGas"])
  })

  test("a malformed estimate is upstream_error", async () => {
    const fake = fakeOf("linea", { linea })
    fake.inject("linea_estimateGas", { result: { gasLimit: "0xcf08", baseFeePerGas: "7", priorityFeePerGas: "0x2" } })
    expect((await toolError(quote(fake))).code).toBe("upstream_error")
    fake.inject("linea_estimateGas", { result: "0x1" })
    expect((await toolError(quote(fake))).code).toBe("upstream_error")
  })

  test("a call linea would revert is invalid_argument", async () => {
    const fake = fakeOf("linea", { linea })
    fake.inject("linea_estimateGas", { error: { code: -32000, message: "execution reverted: nope" } })
    expect((await toolError(quote(fake))).code).toBe("invalid_argument")
  })

  test("a node without linea_estimateGas is a refusal, not a guess", async () => {
    expect((await toolError(quote(fakeOf("linea")))).code).toBe("upstream_error")
  })
})

describe("quoteFees: op", () => {
  const oracle = { l1Fee: 1_000n, operatorFee: 500n, tokenRatio: 1n }

  test("doubles the L1 fee, adds the operator fee as it is, and prices the unsigned transaction", async () => {
    const fake = fakeOf("base", { oracle })
    const result = await quote(fake)
    expect(result).toMatchObject({ gasLimit: 21_000n, maxFeePerGas: 23n, l1Fee: 2_000n, operatorFee: 500n })
    expect(result.needed).toBe(21_000n * 13n + 2_500n)
    expect(result.suggested).toBe(21_000n * 23n + 2_500n)

    const unsigned = unsignedEvmTransactionHex({
      chainId: 8453,
      to: BOB,
      value: 1_000n,
      data: "0x",
      nonce: 4n,
      gasLimit: 21_000n,
      maxFeePerGas: 23n,
      maxPriorityFeePerGas: 3n,
    })
    const [first, second] = fake.requestsOf("eth_call")
    expect(first).toEqual([{ to: FEE_ORACLES.op, data: getL1FeeCall(unsigned) }, "latest"])
    expect(second).toEqual([{ to: FEE_ORACLES.op, data: `0x275aedd2${word(21_000n)}` }, "latest"])
    expect(fake.requestsOf("eth_call")).toHaveLength(2)
  })

  test("the nonce and the call's data are part of what is priced", async () => {
    const fake = fakeOf("base", { oracle })
    await quote(fake, { ...SEND, data: "0xa9059cbb" }, 9n)
    const priced = (fake.requestsOf("eth_call")[0][0] as { data: string }).data
    expect(priced).toBe(
      getL1FeeCall(
        unsignedEvmTransactionHex({
          chainId: 8453,
          to: BOB,
          value: 1_000n,
          data: "0xa9059cbb",
          nonce: 9n,
          gasLimit: 120_000n,
          maxFeePerGas: 23n,
          maxPriorityFeePerGas: 3n,
        }),
      ),
    )
  })

  test("an operator fee that reverts (before Isthmus) reads as 0", async () => {
    const result = await quote(fakeOf("base", { oracle: { ...oracle, operatorFee: "revert" } }))
    expect(result.operatorFee).toBe(0n)
    expect(result.needed).toBe(21_000n * 13n + 2_000n)
  })

  test("an operator fee that fails otherwise is upstream_error", async () => {
    const fake = fakeOf("base", { oracle })
    fake.inject("eth_call", { result: `0x${word(1_000n)}` })
    fake.inject("eth_call", { error: { code: -32000, message: "overloaded" } })
    const error = await toolError(quote(fake))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("The chain's operator fee could not be read")
  })

  test("an operator fee that answers nothing, or an L1 fee that reverts, is upstream_error", async () => {
    const empty = fakeOf("base", { oracle })
    empty.inject("eth_call", { result: `0x${word(1_000n)}` })
    empty.inject("eth_call", { result: "0x" })
    expect((await toolError(quote(empty))).message).toContain("operator fee")
    const reverting = fakeOf("base", { oracle: { ...oracle, l1Fee: "revert" } })
    const error = await toolError(quote(reverting))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("L1 data fee")
  })

  test("a rate limit is not turned into an unreadable fee", async () => {
    const fake = fakeOf("base", { oracle })
    fake.inject("eth_call", { http: { status: 429 } })
    expect((await toolError(quote(fake))).code).toBe("rate_limited")
  })

  test("every OP Stack chain in the table is priced through the oracle", async () => {
    for (const key of ["optimism", "unichain", "celo", "ink", "zora", "world-chain", "base-sepolia"]) {
      const result = await quote(fakeOf(key, { oracle }))
      expect(result.l1Fee).toBe(2_000n)
    }
  })
})

describe("quoteFees: mantle", () => {
  const oracle = { l1Fee: 1_000n, operatorFee: 400n, tokenRatio: 3n }

  test("multiplies the L1 fee by the token ratio before doubling it", async () => {
    const fake = fakeOf("mantle", { oracle })
    const result = await quote(fake)
    expect(result).toMatchObject({ l1Fee: 6_000n, operatorFee: 400n, gasLimit: 21_000n })
    expect(result.needed).toBe(21_000n * 13n + 6_400n)
    expect(result.suggested).toBe(21_000n * 23n + 6_400n)
    expect(fake.requestsOf("eth_call").map(([call]) => (call as { data: string }).data.slice(0, 10))).toEqual([
      "0x49948e0e",
      "0x06f837d3",
      "0x275aedd2",
    ])
  })

  test("an operator fee that reverts is upstream_error, as is a token ratio that does", async () => {
    const noOperator = await toolError(quote(fakeOf("mantle", { oracle: { ...oracle, operatorFee: "revert" } })))
    expect(noOperator.code).toBe("upstream_error")
    expect(noOperator.message).toContain("operator fee")
    const noRatio = await toolError(quote(fakeOf("mantle", { oracle: { ...oracle, tokenRatio: "revert" } })))
    expect(noRatio.message).toContain("token ratio")
  })
})

describe("quoteFees: scroll", () => {
  test("doubles the L1 fee of the placeholder-signed transaction, and asks for no operator fee", async () => {
    const fake = fakeOf("scroll", { oracle: { l1Fee: 1_000n, operatorFee: "revert", tokenRatio: 1n } })
    const result = await quote(fake)
    expect(result).toMatchObject({ l1Fee: 2_000n, operatorFee: 0n, gasLimit: 21_000n })
    expect(result.needed).toBe(21_000n * 13n + 2_000n)
    const signed = placeholderSignedEvmTransactionHex({
      chainId: evmChain("scroll").chainId,
      to: BOB,
      value: 1_000n,
      data: "0x",
      nonce: 4n,
      gasLimit: 21_000n,
      maxFeePerGas: 23n,
      maxPriorityFeePerGas: 3n,
    })
    expect(fake.requestsOf("eth_call")).toEqual([[{ to: FEE_ORACLES.scroll, data: getL1FeeCall(signed) }, "latest"]])
  })

  test("the signed form is longer than the unsigned one", async () => {
    const fake = fakeOf("scroll")
    await quote(fake)
    const [{ data }] = fake.requestsOf("eth_call")[0] as [{ data: string }]
    expect(data.length).toBeGreaterThan(
      getL1FeeCall(
        unsignedEvmTransactionHex({
          chainId: 534352,
          to: BOB,
          value: 1_000n,
          data: "0x",
          nonce: 4n,
          gasLimit: 21_000n,
          maxFeePerGas: 23n,
          maxPriorityFeePerGas: 3n,
        }),
      ).length,
    )
  })
})
