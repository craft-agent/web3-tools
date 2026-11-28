import { afterEach, describe, expect, test } from "bun:test"
import { checkPin } from "../../entry/pin"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { associatedTokenAddress } from "./address"
import { DELEGATE, makeRevokeRig, revokeArgs, type RevokeRig } from "./revoke.testing"
import { cleanRigs, expectRefused, MAIN_ADDRESS, MAIN_TOKENS, MINT } from "./send.testing"
import { testAddress } from "./testing"

afterEach(cleanRigs)

const CANNOT_REVOKE = "invalid_argument"
const NO_DELEGATE = /has no delegate to revoke/
const ACCOUNT = associatedTokenAddress(MAIN_ADDRESS, MINT, SOLANA_PROGRAMS.tokenProgram)

/** Makes the next read of the account at `address` fail as a node does when it is down. */
function failRead(rig: RevokeRig, address: string): void {
  rig.beforeRequest = (method, params) => {
    if (method === "getAccountInfo" && params[0] === address) {
      rig.fake.inject("getAccountInfo", { error: { code: -32000, message: "internal error" } })
    }
  }
}

/** Puts `main`'s token account for `MINT` under Token-2022, with `delegate` as its delegate. */
function moveToToken2022(rig: RevokeRig, delegate: string): void {
  rig.fake.addMint(MINT, { program: SOLANA_PROGRAMS.token2022Program, decimals: 6, supply: MAIN_TOKENS })
  rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, { amount: MAIN_TOKENS, delegate })
}

describe("what there is to revoke", () => {
  test("a wallet with no token account for the mint", async () => {
    const rig = makeRevokeRig()
    rig.fake.addMint(testAddress(6), { decimals: 6 })
    await expectRefused(
      rig,
      revokeArgs({ mint: testAddress(6) }),
      CANNOT_REVOKE,
      new RegExp(`${MAIN_ADDRESS} has no token account for ${testAddress(6)}`),
    )
  })

  test("a token account with no delegate", async () => {
    const rig = makeRevokeRig()
    rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, { amount: MAIN_TOKENS })
    await expectRefused(rig, revokeArgs(), CANNOT_REVOKE, NO_DELEGATE)
  })

  test("a delegate on another token account of the wallet is not covered", async () => {
    const rig = makeRevokeRig()
    rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, { amount: MAIN_TOKENS })
    rig.fake.addTokenAccount(testAddress(14), MINT, MAIN_ADDRESS, { amount: 1n, delegate: DELEGATE })
    await expectRefused(rig, revokeArgs(), CANNOT_REVOKE, NO_DELEGATE)
  })

  test("an address that is no token mint, a compressed NFT or a Core asset among them", async () => {
    const message = /is not a token mint.*a compressed NFT or a Core asset has no SPL mint/
    await expectRefused(makeRevokeRig(), revokeArgs({ mint: MAIN_ADDRESS }), CANNOT_REVOKE, message)
    await expectRefused(makeRevokeRig(), revokeArgs({ mint: testAddress(7) }), CANNOT_REVOKE, message)
  })

  test("a mint that is not an address", async () => {
    await expectRefused(makeRevokeRig(), revokeArgs({ mint: "mint" }), CANNOT_REVOKE, /mint/)
  })
})

describe("a read that fails is not 'nothing to revoke'", () => {
  test("a token account read that fails stops the call", async () => {
    const rig = makeRevokeRig()
    failRead(rig, ACCOUNT)
    const approval = await rig.approve(revokeArgs())
    expect(approval.refused).toMatchObject({ code: "upstream_error" })
    expect(approval.refused?.message).not.toMatch(NO_DELEGATE)
    await expect(rig.run(revokeArgs())).rejects.toMatchObject({ code: "upstream_error" })
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })

  test("a mint read that fails stops the call too", async () => {
    const rig = makeRevokeRig()
    failRead(rig, MINT)
    await expect(rig.run(revokeArgs())).rejects.toMatchObject({ code: "upstream_error" })
    expect(rig.broadcasts()).toHaveLength(0)
  })
})

describe("refusals before anyone is asked", () => {
  test("a frozen token account, which the cluster's simulation says cannot be revoked", async () => {
    const rig = makeRevokeRig()
    rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, {
      amount: MAIN_TOKENS,
      delegate: DELEGATE,
      state: "frozen",
    })
    await expectRefused(rig, revokeArgs(), CANNOT_REVOKE, /would fail this transaction.*frozen/s)
  })

  test("a wallet that would be left below the rent-exempt minimum by max_fee", async () => {
    const rig = makeRevokeRig()
    rig.fake.setBalance(MAIN_ADDRESS, rig.fake.rentFor(0) + 99_999n)
    await expectRefused(rig, revokeArgs(), CANNOT_REVOKE, /never left below.*rent-exempt minimum.*smaller max_fee/)
    rig.fake.setBalance(MAIN_ADDRESS, rig.fake.rentFor(0) + 100_000n)
    expect((await rig.approve(revokeArgs())).refused).toBeUndefined()
  })

  test("a max_fee below what the cluster asks now", async () => {
    const rig = makeRevokeRig()
    rig.fake.priorityFees = [10_000_000n]
    await expectRefused(
      rig,
      revokeArgs({ max_fee: "4999" }),
      CANNOT_REVOKE,
      /below the \d+ lamports the network asks now/,
    )
  })

  test("a sender with no key, before any request to the cluster", async () => {
    const rig = makeRevokeRig()
    const approval = await rig.approve(revokeArgs({ account: "ghost" }))
    expect(approval.refused).toBeDefined()
    expect(rig.fake.requests).toHaveLength(0)
  })

  test("an earlier write the cluster may still land", async () => {
    const rig = makeRevokeRig()
    rig.fake.failSend({ transport: "timeout", accepted: true })
    rig.mineAtMs = undefined
    const first = await rig.run(revokeArgs())
    expect(first.outcome).toBe("pending")
    const approval = await rig.approve(revokeArgs())
    expect(approval.refused).toMatchObject({ code: "stale" })
    expect(approval.refused?.message).toContain(first.signature)
    expect(rig.broadcasts()).toHaveLength(1)
  })

  test("sends_per_hour counts a revoke like any other write", async () => {
    const rig = makeRevokeRig({ options: { sends_per_hour: 1 } })
    const other = testAddress(4)
    rig.fake.addMint(other, { decimals: 6 })
    rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, other, { amount: 1n, delegate: DELEGATE })
    expect((await rig.run(revokeArgs())).outcome).toBe("confirmed")
    const another = revokeArgs({ mint: other })
    expect((await rig.approve(another)).refused).toMatchObject({ code: "rate_limited" })
    await expect(rig.tool.execute(rig.tool.input.parse(another), rig.ctx)).rejects.toMatchObject({
      code: "rate_limited",
    })
    expect(rig.broadcasts()).toHaveLength(1)
  })
})

describe("a revoke whose approval no longer holds", () => {
  test("is stale when the mint's program changed after the prompt, moving the token account and the instruction", async () => {
    const rig = makeRevokeRig()
    const { pin } = await rig.approve(revokeArgs())
    moveToToken2022(rig, DELEGATE)
    await expect(checkPin(rig.tool, revokeArgs(), rig.ctx, pin)).rejects.toMatchObject({ code: "stale" })
    expect(rig.broadcasts()).toHaveLength(0)
  })

  test("is stale when the token account named another delegate after the prompt", async () => {
    const rig = makeRevokeRig()
    const { pin } = await rig.approve(revokeArgs())
    rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, { amount: MAIN_TOKENS, delegate: testAddress(10) })
    await expect(checkPin(rig.tool, revokeArgs(), rig.ctx, pin)).rejects.toMatchObject({ code: "stale" })
    expect(rig.broadcasts()).toHaveLength(0)
  })

  test("is stale under the lock when the call changed between the run's first look and its second", async () => {
    const rig = makeRevokeRig()
    let looks = 0
    rig.beforeRequest = (method, params) => {
      if (method === "getAccountInfo" && params[0] === MINT && ++looks === 2) moveToToken2022(rig, DELEGATE)
    }
    await expect(rig.tool.execute(rig.tool.input.parse(revokeArgs()), rig.ctx)).rejects.toMatchObject({
      code: "stale",
    })
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })

  test("a delegate that was revoked meanwhile is refused as nothing to revoke when it runs", async () => {
    const rig = makeRevokeRig()
    expect((await rig.approve(revokeArgs())).refused).toBeUndefined()
    rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, { amount: MAIN_TOKENS })
    await expect(rig.invoke(revokeArgs())).rejects.toMatchObject({ code: CANNOT_REVOKE })
    expect(rig.broadcasts()).toHaveLength(0)
  })
})
