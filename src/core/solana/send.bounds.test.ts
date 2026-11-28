import { afterEach, describe, expect, test } from "bun:test"
import { matchGrant, measureOf } from "../grant/match"
import type { Grant } from "../grant/model"
import { SEND_BOUNDS } from "./send.bounds"
import { BOB, cleanRigs, LAMPORTS_PER_SOL, makeRig, MAX_FEE, MINT, solArgs, tokenArgs } from "./send.testing"
import { testAddress } from "./testing"

afterEach(cleanRigs)

describe("what a send measures", () => {
  test("a SOL send: the cluster's coin, the recipient as written, the amount in lamports and the fee ceiling", async () => {
    const rig = makeRig()
    expect(await rig.tool.measure!(rig.tool.input.parse(solArgs()), rig.ctx)).toEqual({
      asset: "solana/native",
      recipient: BOB,
      amount: Number(LAMPORTS_PER_SOL),
      max_fee: Number(MAX_FEE),
    })
  })

  test("a token send: the mint as written, and the amount in the token's smallest unit", async () => {
    const rig = makeRig()
    expect(await rig.tool.measure!(rig.tool.input.parse(tokenArgs({ amount: "2.5" })), rig.ctx)).toMatchObject({
      asset: `solana/${MINT}`,
      amount: 2_500_000,
    })
  })

  test("an amount past 2^53 is measured at or above its true value", async () => {
    const rig = makeRig()
    const measured = await rig.tool.measure!(rig.tool.input.parse(solArgs({ amount: "9007199.254740993" })), rig.ctx)
    expect(BigInt(measured.amount as number) >= 2n ** 53n + 1n).toBe(true)
    expect(measured.amount).toBe(2 ** 53 + 2)
  })

  test("is in the shape a grant reads, and a grant over a cluster, a mint or a ceiling covers what it names", async () => {
    const rig = makeRig()
    const bounds = SEND_BOUNDS
    const grant = (limits: Grant["bounds"]): Grant => ({
      id: "g",
      tool: "web3_solana_send",
      targets: ["*"],
      bounds: limits,
      rate: null,
      created_at: "2026-05-01T00:00:00Z",
      expires_at: "2026-07-01T00:00:00Z",
      reason: "test",
    })
    const covered = async (args: Record<string, unknown>, limits: Grant["bounds"]) => {
      const measure = await rig.tool.measure!(rig.tool.input.parse(args), rig.ctx)
      expect(measureOf(bounds, measure)).toBeDefined()
      const call = { tool: "web3_solana_send", targets: ["*"], measure: measureOf(bounds, measure) }
      return matchGrant({ call, bounds, grants: [grant(limits)], now: new Date("2026-06-01T00:00:00Z"), used: () => 0 })
        .covered
    }
    expect(await covered(solArgs(), { asset: ["solana"] })).toBe(true)
    expect(await covered(tokenArgs(), { asset: ["solana"] })).toBe(true)
    expect(await covered(solArgs(), { asset: ["solana/native"] })).toBe(true)
    expect(await covered(tokenArgs(), { asset: ["solana/native"] })).toBe(false)
    expect(await covered(tokenArgs(), { asset: [`solana/${MINT}`] })).toBe(true)
    expect(MINT).not.toBe(MINT.toLowerCase())
    expect(await covered(tokenArgs(), { asset: [`solana/${MINT.toLowerCase()}`] })).toBe(false)
    expect(await covered(solArgs(), { asset: ["solana-devnet"] })).toBe(false)
    expect(await covered(solArgs(), { recipient: [BOB] })).toBe(true)
    expect(await covered(solArgs({ to: testAddress(5) }), { recipient: [BOB] })).toBe(false)
    expect(await covered(solArgs(), { amount: Number(LAMPORTS_PER_SOL) })).toBe(true)
    expect(await covered(solArgs({ amount: "1.000000001" }), { amount: Number(LAMPORTS_PER_SOL) })).toBe(false)
    expect(await covered(solArgs(), { max_fee: Number(MAX_FEE) - 1 })).toBe(false)
  })
})
