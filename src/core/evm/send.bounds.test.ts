import { afterEach, describe, expect, test } from "bun:test"
import { matchGrant, measureOf } from "../grant/match"
import type { Grant } from "../grant/model"
import { ceilToNumber, SEND_BOUNDS } from "./send.bounds"
import { cleanRigs, ETHER, makeRig, MAX_FEE, nativeArgs, TOKEN_ADDRESS, tokenArgs } from "./send.testing"
import { HARDHAT_ADDRESS_1 } from "./testing.sign"

afterEach(cleanRigs)

const TWO_POW_53 = 2n ** 53n

describe("ceilToNumber", () => {
  test("is exact up to 2^53", () => {
    for (const value of [0n, 1n, 12345n, TWO_POW_53 - 1n, TWO_POW_53]) {
      expect(BigInt(ceilToNumber(value))).toBe(value)
    }
  })

  test("rounds up, never below the amount, to the next double above 2^53", () => {
    expect(ceilToNumber(TWO_POW_53 + 1n)).toBe(2 ** 53 + 2)
    expect(ceilToNumber(TWO_POW_53 + 2n)).toBe(2 ** 53 + 2)
    expect(ceilToNumber(2n ** 64n + 1n)).toBe(2 ** 64 + 2 ** 12)
    expect(ceilToNumber(2n ** 256n - 1n)).toBe(2 ** 256)
    expect(Number.isFinite(ceilToNumber(2n ** 256n - 1n))).toBe(true)
  })

  test("is never below the bigint and never more than one step above it, for values of every size", () => {
    let value = 3n
    for (let bits = 0; bits < 256; bits++) {
      for (const candidate of [value - 1n, value, value + 1n, value * 7n + 5n]) {
        if (candidate < 0n || candidate >= 2n ** 256n) continue
        const result = ceilToNumber(candidate)
        const exact = BigInt(result)
        expect(exact >= candidate).toBe(true)
        const step = candidate > TWO_POW_53 ? 2n ** BigInt(candidate.toString(2).length - 53) : 1n
        expect(exact - candidate < step).toBe(true)
      }
      value = value * 2n + 1n
    }
  })
})

describe("what a send measures", () => {
  test("a native send: the chain's coin, the recipient in lower case, the amount and the fee ceiling in wei", async () => {
    const rig = makeRig()
    expect(await rig.tool.measure!(rig.tool.input.parse(nativeArgs()), rig.ctx)).toEqual({
      asset: "ethereum/native",
      recipient: HARDHAT_ADDRESS_1.toLowerCase(),
      amount: 1e18,
      max_fee: Number(MAX_FEE),
    })
  })

  test("a token send: the token's address in lower case, and the amount in the token's smallest unit", async () => {
    const rig = makeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, { decimals: 6, balances: {} })
    expect(await rig.tool.measure!(rig.tool.input.parse(tokenArgs({ amount: "2.5" })), rig.ctx)).toMatchObject({
      asset: `ethereum/${TOKEN_ADDRESS.toLowerCase()}`,
      amount: 2_500_000,
    })
  })

  test("an amount past 2^53 is measured at or above its true value", async () => {
    const rig = makeRig()
    const measured = await rig.tool.measure!(
      rig.tool.input.parse(nativeArgs({ amount: "0.009007199254740993" })),
      rig.ctx,
    )
    expect(BigInt(measured.amount as number) >= TWO_POW_53 + 1n).toBe(true)
    expect(measured.amount).toBe(2 ** 53 + 2)
  })

  test("is in the shape a grant reads, and a grant over a chain, a token or a ceiling covers what it names", async () => {
    const rig = makeRig()
    const bounds = SEND_BOUNDS
    const grant = (limits: Grant["bounds"]): Grant => ({
      id: "g",
      tool: "web3_evm_send",
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
      const call = { tool: "web3_evm_send", targets: ["*"], measure: measureOf(bounds, measure) }
      return matchGrant({ call, bounds, grants: [grant(limits)], now: new Date("2026-06-01T00:00:00Z"), used: () => 0 })
        .covered
    }
    expect(await covered(nativeArgs(), { asset: ["ethereum"] })).toBe(true)
    expect(await covered(tokenArgs(), { asset: ["ethereum"] })).toBe(true)
    expect(await covered(nativeArgs(), { asset: ["ethereum/native"] })).toBe(true)
    expect(await covered(tokenArgs(), { asset: ["ethereum/native"] })).toBe(false)
    expect(await covered(tokenArgs(), { asset: [`ethereum/${TOKEN_ADDRESS.toLowerCase()}`] })).toBe(true)
    expect(await covered(nativeArgs(), { asset: ["base"] })).toBe(false)
    expect(await covered(nativeArgs(), { recipient: [HARDHAT_ADDRESS_1.toLowerCase()] })).toBe(true)
    expect(
      await covered(nativeArgs({ to: "0x1111111111111111111111111111111111111111" }), {
        recipient: [HARDHAT_ADDRESS_1.toLowerCase()],
      }),
    ).toBe(false)
    expect(await covered(nativeArgs(), { amount: Number(ETHER) })).toBe(true)
    expect(await covered(nativeArgs({ amount: "1.000000000000000001" }), { amount: Number(ETHER) })).toBe(false)
    expect(await covered(nativeArgs(), { max_fee: Number(MAX_FEE) - 1 })).toBe(false)
  })
})
