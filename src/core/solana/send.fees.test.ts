import { afterEach, describe, expect, test } from "bun:test"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { associatedTokenAddress } from "./address"
import { LAMPORTS_PER_SIGNATURE, priorityFee } from "./fees"
import { BOB, cleanRigs, MAIN_ADDRESS, makeRig, MINT, solArgs, tokenArgs, type SendRig } from "./send.testing"
import { decodeTransaction } from "./testing.cluster.tx"

afterEach(cleanRigs)

/** The compute budget the signed transaction the fake received carries, and the fee it can cost at most. */
function budgetOf(rig: SendRig): { unitLimit: number; unitPrice: bigint; worstFee: bigint; instructions: number } {
  const { instructions } = decodeTransaction(rig.broadcasts()[0]!).message
  const [limit, price] = instructions
  expect(limit!.programId).toBe(SOLANA_PROGRAMS.computeBudgetProgram)
  expect(price!.programId).toBe(SOLANA_PROGRAMS.computeBudgetProgram)
  const unitLimit = new DataView(limit!.data.buffer, limit!.data.byteOffset).getUint32(1, true)
  const unitPrice = new DataView(price!.data.buffer, price!.data.byteOffset).getBigUint64(1, true)
  return {
    unitLimit,
    unitPrice,
    worstFee: LAMPORTS_PER_SIGNATURE + priorityFee(unitPrice, unitLimit),
    instructions: instructions.length,
  }
}

describe("the fee a send is signed with", () => {
  test("is the base fee alone when no recent block paid a priority fee", async () => {
    const rig = makeRig()
    await rig.run(solArgs())
    expect(budgetOf(rig)).toMatchObject({ unitPrice: 0n, worstFee: 5000n, instructions: 3 })
  })

  test("never costs more than max_fee, whatever the network's price, and the cluster charges what was signed", async () => {
    for (const maxFee of [12_500n, 15_000n, 17_777n, 1_000_000n]) {
      const rig = makeRig()
      rig.fake.priorityFees = [10_000_000n]
      const before = rig.fake.balanceOf(MAIN_ADDRESS)
      await rig.run(solArgs({ max_fee: String(maxFee) }))
      const { worstFee, unitPrice } = budgetOf(rig)
      expect(worstFee).toBeLessThanOrEqual(maxFee)
      expect(unitPrice).toBeLessThanOrEqual(20_000_000n)
      expect(before - rig.fake.balanceOf(MAIN_ADDRESS)).toBe(10n ** 9n + worstFee)
    }
  })

  test("a token send that creates an account is held to max_fee as well, with both token instructions", async () => {
    const rig = makeRig()
    rig.fake.priorityFees = [1_000_000n]
    await rig.run(tokenArgs({ max_fee: "20000" }))
    const { worstFee, instructions } = budgetOf(rig)
    expect(instructions).toBe(4)
    expect(worstFee).toBeLessThanOrEqual(20_000n)
    expect(worstFee).toBeGreaterThan(5000n)
  })

  test("prices the fee on the accounts the send writes to", async () => {
    const rig = makeRig()
    await rig.approve(tokenArgs())
    const [[writable]] = rig.fake.requestsOf("getRecentPrioritizationFees")
    const program = SOLANA_PROGRAMS.tokenProgram
    expect(writable).toEqual([
      MAIN_ADDRESS,
      associatedTokenAddress(BOB, MINT, program),
      associatedTokenAddress(MAIN_ADDRESS, MINT, program),
    ])
  })
})

describe("fees that rise after the prompt", () => {
  test("fail the send as stale before a row is written, with nothing sent", async () => {
    const rig = makeRig()
    rig.fake.priorityFees = [10_000_000n]
    rig.beforeRequest = (method) => {
      if (method === "getLatestBlockhash") rig.fake.priorityFees = [1_000_000_000n]
    }
    const error = await rig.run(solArgs({ max_fee: "13000" })).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "stale" })
    expect((error as Error).message).toContain("max_fee is 13000")
    expect((error as Error).message).toContain("Nothing was sent")
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })

  test("a simulation the cluster fails once the blockhash is taken fails the send before a row too", async () => {
    const rig = makeRig()
    rig.beforeRequest = (method) => {
      if (method !== "getLatestBlockhash") return
      rig.fake.setBalance(MAIN_ADDRESS, 1000n)
    }
    await expect(rig.run(solArgs())).rejects.toMatchObject({ code: "invalid_argument" })
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })
})
