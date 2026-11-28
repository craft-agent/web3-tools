import { afterEach, describe, expect, test } from "bun:test"
import { cleanRigs, GWEI, makeRig, nativeArgs, tokenArgs } from "./send.testing"
import { HARDHAT_ADDRESS_0 } from "./testing.sign"

afterEach(cleanRigs)

/** What a plain transfer needs on a chain with base fee 1 gwei and tip 0.1 gwei: 21000 gas at 1.1 gwei. */
const NEEDED = 21_000n * (GWEI + GWEI / 10n)
const SUGGESTED = 21_000n * (2n * GWEI + GWEI / 10n)

describe("max_fee below what the network asks", () => {
  test("is refused before anyone is asked, naming what is needed and what leaves room", async () => {
    const rig = makeRig()
    const args = nativeArgs({ max_fee: String(NEEDED - 1n) })
    const approval = await rig.approve(args)
    expect(approval.refused).toMatchObject({ code: "invalid_argument" })
    expect(approval.refused?.message).toContain(`${NEEDED} wei`)
    expect(approval.refused?.message).toContain(`${SUGGESTED} wei leaves room`)
    await expect(rig.run(args)).rejects.toMatchObject({ code: "invalid_argument" })
    expect(rig.fake.requestsOf("eth_sendRawTransaction")).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })

  test("exactly what the network asks is enough, and the transaction is signed with no more", async () => {
    const rig = makeRig()
    const result = await rig.run(nativeArgs({ max_fee: String(NEEDED) }))
    expect(result.outcome).toBe("confirmed")
    const tx = rig.fake.receiptOf(result.hash)!.tx
    expect(tx.gasLimit * tx.maxFeePerGas).toBeLessThanOrEqual(NEEDED)
    expect(tx.maxFeePerGas).toBe(GWEI + GWEI / 10n)
  })

  test("a token transfer is priced with its own gas, 20% over the node's estimate", async () => {
    const rig = makeRig()
    const needed = 78_000n * 1_100_000_000n
    expect((await rig.approve(tokenArgs({ max_fee: String(needed - 1n) }))).refused).toMatchObject({
      code: "invalid_argument",
    })
    expect((await rig.run(tokenArgs({ max_fee: String(needed) }))).outcome).toBe("confirmed")
  })
})

describe("what is signed never costs more than max_fee", () => {
  test("gas at the signed fee, plus the L1 data fee and the operator fee, stays under it", async () => {
    const rig = makeRig({ chain: "base" })
    rig.fake.oracle = { l1Fee: 10n ** 12n, operatorFee: 3n * 10n ** 11n, tokenRatio: 1n }
    const l1AndOperator = 2n * 10n ** 12n + 3n * 10n ** 11n
    const maxFee = (21_000n * 13n * GWEI) / 10n + l1AndOperator
    const result = await rig.run(nativeArgs({ chain: "base", max_fee: String(maxFee) }))
    const { tx } = rig.fake.receiptOf(result.hash)!
    expect(tx.gasLimit * tx.maxFeePerGas + l1AndOperator).toBeLessThanOrEqual(maxFee)
    expect(tx.maxFeePerGas).toBeLessThan(2n * GWEI + GWEI / 10n)
    expect(tx.maxPriorityFeePerGas).toBeLessThanOrEqual(tx.maxFeePerGas)
  })

  test("a generous ceiling signs the fee the network asks for with its headroom, not the ceiling", async () => {
    const rig = makeRig()
    const result = await rig.run(nativeArgs({ max_fee: String(10n ** 17n) }))
    const { tx } = rig.fake.receiptOf(result.hash)!
    expect(tx.maxFeePerGas).toBe(2n * GWEI + GWEI / 10n)
    expect(tx.gasLimit).toBe(21_000n)
  })
})

describe("network fees that rise after the prompt", () => {
  test("make the send stale, with no row written and nothing sent", async () => {
    const rig = makeRig()
    let counts = 0
    rig.beforeRequest = (method, params) => {
      if (method === "eth_getTransactionCount" && params[1] === "pending" && ++counts === 2)
        rig.fake.baseFee = 2n * GWEI
    }
    const error = await rig.invoke(nativeArgs({ max_fee: String(NEEDED) })).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "stale" })
    expect((error as Error).message).toContain("Nothing was sent")
    expect(counts).toBe(2)
    expect(rig.fake.requestsOf("eth_sendRawTransaction")).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
    expect(rig.fake.nonceOf(HARDHAT_ADDRESS_0)).toBe(0n)
  })
})
