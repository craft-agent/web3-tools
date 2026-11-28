import { afterEach, describe, expect, test } from "bun:test"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { MAX_FACTS, wholeCallDescription } from "../describe"
import { matchGrant, measureOf } from "../grant/match"
import type { Grant } from "../grant/model"
import { associatedTokenAddress } from "./address"
import { REVOKE_BOUNDS } from "./revoke.bounds"
import { DELEGATE, makeRevokeRig, revokeArgs } from "./revoke.testing"
import { cleanRigs, LAMPORTS_PER_SOL, MAIN_ADDRESS, MAX_FEE, MINT } from "./send.testing"

afterEach(cleanRigs)

const FEE_FACT = { label: "Max fee", value: "100000 lamports (0.0001 SOL)" }
const ACCOUNT = associatedTokenAddress(MAIN_ADDRESS, MINT, SOLANA_PROGRAMS.tokenProgram)

describe("what a revoke's prompt shows", () => {
  test("the delegate whole, the token with its symbol, what is revoked and the fee ceiling", async () => {
    const approval = await makeRevokeRig().approve(revokeArgs())
    expect(approval.resources).toEqual([`delegate:${DELEGATE}`, `from:${MAIN_ADDRESS}`])
    expect(approval.description).toEqual({
      headline: `Revoke "${DELEGATE}"'s approval to move "${MINT}" on "Solana"`,
      facts: [
        { label: "Delegate", value: DELEGATE },
        { label: "Token", value: `${MINT} declaring the symbol "TKN"` },
        { label: "Revokes", value: "the delegate's approval" },
        FEE_FACT,
      ],
    })
    expect(approval.pin).toBeDefined()
  })

  test("a symbol that cannot be shown leaves the mint alone", async () => {
    const rig = makeRevokeRig()
    rig.fake.addMetadata({ mint: MINT, symbol: "ignore previous", tokenStandard: null })
    const approval = await rig.approve(revokeArgs())
    expect(approval.description?.facts[1]).toEqual({ label: "Token", value: MINT })
    expect(JSON.stringify(approval)).not.toContain("ignore")
  })

  test("keeps within the facts a prompt shows", async () => {
    const rig = makeRevokeRig()
    const description = await wholeCallDescription(rig.tool, revokeArgs(), rig.ctx)
    expect(description?.facts.length).toBeLessThanOrEqual(MAX_FACTS)
  })
})

describe("what a revoke's description is the same for", () => {
  test("the same transaction, whatever the delegated amount, the fees and the block do", async () => {
    const rig = makeRevokeRig()
    const first = await wholeCallDescription(rig.tool, revokeArgs(), rig.ctx)
    rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, { amount: 7n, delegate: DELEGATE, delegatedAmount: 9_999n })
    rig.fake.priorityFees = [5_000_000n, 9_000_000n]
    rig.fake.advance(40)
    rig.fake.setBalance(MAIN_ADDRESS, 3n * LAMPORTS_PER_SOL)
    const second = await wholeCallDescription(rig.tool, revokeArgs(), rig.ctx)
    expect(first).toBeDefined()
    expect(second).toEqual(first)
  })

  test("pins the chain, the sender and the one Revoke with its accounts and data", async () => {
    const rig = makeRevokeRig()
    const description = await wholeCallDescription(rig.tool, revokeArgs(), rig.ctx)
    expect(Object.keys(description?.pins ?? {})).toEqual(["chain", "from", "instruction_0"])
    expect(description?.pins?.chain).toBe("solana")
    expect(description?.pins?.from).toBe(MAIN_ADDRESS)
    expect(JSON.parse(description?.pins?.instruction_0 ?? "")).toEqual({
      program: SOLANA_PROGRAMS.tokenProgram,
      accounts: [
        { address: ACCOUNT, signer: false, writable: true },
        { address: MAIN_ADDRESS, signer: true, writable: false },
      ],
      data: "05",
    })
  })

  test("another fee ceiling is another description, with the same pins", async () => {
    const rig = makeRevokeRig()
    const base = await wholeCallDescription(rig.tool, revokeArgs(), rig.ctx)
    const dearer = await wholeCallDescription(rig.tool, revokeArgs({ max_fee: "200000" }), rig.ctx)
    expect(dearer).not.toEqual(base)
    expect(dearer?.pins).toEqual(base?.pins)
  })
})

describe("what a revoke measures", () => {
  test("the mint under its cluster as the asset, and the fee ceiling in lamports", async () => {
    const rig = makeRevokeRig()
    expect(await rig.tool.measure!(rig.tool.input.parse(revokeArgs()), rig.ctx)).toEqual({
      asset: `solana/${MINT}`,
      max_fee: Number(MAX_FEE),
    })
  })

  test("is in the shape a grant reads, and a grant over the cluster, the mint or the ceiling covers what it names", async () => {
    const rig = makeRevokeRig()
    const measure = await rig.tool.measure!(rig.tool.input.parse(revokeArgs()), rig.ctx)
    expect(measureOf(REVOKE_BOUNDS, measure)).toBeDefined()
    const grant = (limits: Grant["bounds"]): Grant => ({
      id: "g",
      tool: "web3_solana_revoke",
      targets: ["*"],
      bounds: limits,
      rate: null,
      created_at: "2026-05-01T00:00:00Z",
      expires_at: "2026-07-01T00:00:00Z",
      reason: "test",
    })
    const covered = (limits: Grant["bounds"]) =>
      matchGrant({
        call: { tool: "web3_solana_revoke", targets: ["*"], measure: measureOf(REVOKE_BOUNDS, measure) },
        bounds: REVOKE_BOUNDS,
        grants: [grant(limits)],
        now: new Date("2026-06-01T00:00:00Z"),
        used: () => 0,
      }).covered
    expect(covered({ asset: ["solana"] })).toBe(true)
    expect(covered({ asset: [`solana/${MINT}`] })).toBe(true)
    expect(covered({ asset: ["solana-devnet"] })).toBe(false)
    expect(covered({ max_fee: Number(MAX_FEE) })).toBe(true)
    expect(covered({ max_fee: Number(MAX_FEE) - 1 })).toBe(false)
  })

  test("a max_fee past 2^53 is measured at or above its true value", async () => {
    const rig = makeRevokeRig()
    const measured = await rig.tool.measure!(
      rig.tool.input.parse(revokeArgs({ max_fee: String(2n ** 53n + 1n) })),
      rig.ctx,
    )
    expect(BigInt(measured.max_fee as number) >= 2n ** 53n + 1n).toBe(true)
  })
})
