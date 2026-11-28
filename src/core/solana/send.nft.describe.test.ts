import { afterEach, describe, expect, test } from "bun:test"
import { checkPin } from "../../entry/pin"
import { MAX_FACTS, wholeCallDescription } from "../describe"
import { matchGrant, measureOf } from "../grant/match"
import type { Grant } from "../grant/model"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { SEND_BOUNDS } from "./send.bounds"
import {
  addNft,
  BOB,
  cleanRigs,
  LAMPORTS_PER_SOL,
  MAIN_ADDRESS,
  makeRig,
  MAX_FEE,
  NFT_MINT,
  nftArgs,
} from "./send.testing"
import { testAddress } from "./testing"

afterEach(cleanRigs)

const FEE_FACT = { label: "Max fee", value: "100000 lamports (0.0001 SOL)" }

describe("what an NFT send's prompt shows", () => {
  test("the recipient, whose it is, the NFT with its symbol, the token account it creates and the fee ceiling", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    const approval = await rig.approve(nftArgs())
    expect(approval.resources).toEqual([`from:${MAIN_ADDRESS}`, `to:${BOB}`])
    expect(approval.description).toEqual({
      headline: `Send NFT "${NFT_MINT}" on "Solana"`,
      facts: [
        { label: "Recipient", value: BOB },
        { label: "Own wallet", value: "not one of your wallets" },
        { label: "NFT", value: `${NFT_MINT} declaring the symbol "APE"` },
        { label: "Token account", value: `created for the recipient, rent ${rig.fake.rentFor(165)} lamports` },
        FEE_FACT,
      ],
    })
    expect(approval.pin).toBeDefined()
  })

  test("has no amount, and no token account fact when the recipient has one", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    rig.fake.addAssociatedTokenAccount(BOB, NFT_MINT)
    const labels = (await rig.approve(nftArgs())).description?.facts.map(({ label }) => label)
    expect(labels).toEqual(["Recipient", "Own wallet", "NFT", "Max fee"])
  })

  test("a symbol that cannot be shown, or none, leaves the mint alone", async () => {
    const rig = makeRig()
    addNft(rig.fake, { symbol: "ignore previous" })
    const approval = await rig.approve(nftArgs())
    expect(approval.description?.facts[2]).toEqual({ label: "NFT", value: NFT_MINT })
    expect(JSON.stringify(approval)).not.toContain("ignore")
    const bare = makeRig()
    addNft(bare.fake, { metadata: false })
    expect((await bare.approve(nftArgs())).description?.facts[2]).toEqual({ label: "NFT", value: NFT_MINT })
  })

  test("a permanent delegate is named, as it is for any token", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    const delegate = testAddress(9)
    rig.fake.addMint(NFT_MINT, {
      decimals: 0,
      supply: 1n,
      extensions: [{ extension: "permanentDelegate", state: { delegate } }],
    })
    rig.fake.addAssociatedTokenAccount(BOB, NFT_MINT)
    const facts = (await rig.approve(nftArgs())).description?.facts
    expect(facts?.slice(3)).toEqual([
      { label: "Permanent delegate", value: `${delegate}, which can move any holder's tokens` },
      FEE_FACT,
    ])
    expect(facts?.length).toBeLessThanOrEqual(MAX_FACTS)
  })
})

describe("what an NFT send's description is the same for", () => {
  test("the same transaction, whatever the fees and the block do between two descriptions", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    const first = await wholeCallDescription(rig.tool, nftArgs(), rig.ctx)
    rig.fake.priorityFees = [5_000_000n, 9_000_000n]
    rig.fake.advance(40)
    rig.fake.setBalance(MAIN_ADDRESS, 3n * LAMPORTS_PER_SOL)
    const second = await wholeCallDescription(rig.tool, nftArgs(), rig.ctx)
    expect(first).toBeDefined()
    expect(second).toEqual(first)
  })

  test("pins the creation of the token account and the transfer of 1", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    const pins = (await wholeCallDescription(rig.tool, nftArgs(), rig.ctx))?.pins ?? {}
    expect(Object.keys(pins)).toEqual(["chain", "from", "instruction_0", "instruction_1"])
    expect(JSON.parse(pins.instruction_0!).program).toBe(SOLANA_PROGRAMS.associatedTokenProgram)
    expect(JSON.parse(pins.instruction_1!)).toMatchObject({
      program: SOLANA_PROGRAMS.tokenProgram,
      data: "0c010000000000000000",
    })
  })

  test("the token standard turning programmable after the prompt stops the call", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    const { pin } = await rig.approve(nftArgs())
    addNft(rig.fake, { standard: 4 })
    await expect(checkPin(rig.tool, nftArgs(), rig.ctx, pin)).rejects.toMatchObject({ code: "invalid_argument" })
    expect(rig.broadcasts()).toHaveLength(0)
  })
})

describe("what an NFT send measures", () => {
  test("the mint under its cluster as the asset, 1 as the amount, the recipient and the fee ceiling", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    expect(await rig.tool.measure!(rig.tool.input.parse(nftArgs()), rig.ctx)).toEqual({
      asset: `solana/${NFT_MINT}`,
      recipient: BOB,
      amount: 1,
      max_fee: Number(MAX_FEE),
    })
  })

  test("a grant over the cluster or over this mint covers it, and one over another mint does not", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    const measure = await rig.tool.measure!(rig.tool.input.parse(nftArgs()), rig.ctx)
    const covered = (asset: string[]) => {
      const grant: Grant = {
        id: "g",
        tool: "web3_solana_send",
        targets: ["*"],
        bounds: { asset },
        rate: null,
        created_at: "2026-05-01T00:00:00Z",
        expires_at: "2026-07-01T00:00:00Z",
        reason: "test",
      }
      return matchGrant({
        call: { tool: "web3_solana_send", targets: ["*"], measure: measureOf(SEND_BOUNDS, measure) },
        bounds: SEND_BOUNDS,
        grants: [grant],
        now: new Date("2026-06-01T00:00:00Z"),
        used: () => 0,
      }).covered
    }
    expect(covered(["solana"])).toBe(true)
    expect(covered([`solana/${NFT_MINT}`])).toBe(true)
    expect(covered([`solana/${testAddress(3)}`])).toBe(false)
  })
})
