import { afterEach, describe, expect, test } from "bun:test"
import { checkPin } from "../../entry/pin"
import { MAX_FACTS, wholeCallDescription } from "../describe"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { resolveAccount } from "../signer/accounts"
import { HARDHAT_PHRASE } from "../signer/testing"
import {
  BOB,
  cleanRigs,
  LAMPORTS_PER_SOL,
  MAIN_ADDRESS,
  MAIN_TOKENS,
  makeRig,
  MINT,
  solArgs,
  tokenArgs,
} from "./send.testing"
import { testAddress } from "./testing"

afterEach(cleanRigs)

const DELEGATE = testAddress(9)
const FEE_FACT = { label: "Max fee", value: "100000 lamports (0.0001 SOL)" }

describe("what a send's prompt shows", () => {
  test("a SOL send: the recipient, whose it is, the coin, the amount and the fee ceiling, in that order", async () => {
    const approval = await makeRig().approve(solArgs({ amount: "1.5" }))
    expect(approval.resources).toEqual([`from:${MAIN_ADDRESS}`, `to:${BOB}`])
    expect(approval.description).toEqual({
      headline: 'Send "1.5" "SOL" on "Solana"',
      facts: [
        { label: "Recipient", value: BOB },
        { label: "Own wallet", value: "not one of your wallets" },
        { label: "Token", value: "Solana's native coin SOL" },
        { label: "Amount", value: "1.5 SOL (1500000000 lamports)" },
        FEE_FACT,
      ],
    })
    expect(approval.pin).toBeDefined()
  })

  test("a token send names the mint with the declared symbol quoted, the scale, and the token account it creates", async () => {
    const rig = makeRig()
    const approval = await rig.approve(tokenArgs())
    expect(approval.description?.headline).toBe('Send "5" "TKN" on "Solana"')
    expect(approval.description?.facts.slice(2)).toEqual([
      { label: "Token", value: `${MINT} declaring the symbol "TKN"` },
      { label: "Amount", value: "5 TKN (5000000 smallest units, 6 decimals)" },
      { label: "Token account", value: `created for the recipient, rent ${rig.fake.rentFor(165)} lamports` },
      FEE_FACT,
    ])
  })

  test("a token account that exists is not mentioned", async () => {
    const rig = makeRig()
    rig.fake.addAssociatedTokenAccount(BOB, MINT)
    const labels = (await rig.approve(tokenArgs())).description?.facts.map(({ label }) => label)
    expect(labels).toEqual(["Recipient", "Own wallet", "Token", "Amount", "Max fee"])
  })

  test("the rent is the one the cluster's simulation gives the Token-2022 account, which is larger", async () => {
    const rig = makeRig()
    const mint = testAddress(4)
    rig.fake.addMint(mint, {
      program: SOLANA_PROGRAMS.token2022Program,
      decimals: 9,
      extensions: [{ extension: "metadataPointer" }],
    })
    rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, mint, { amount: LAMPORTS_PER_SOL })
    rig.fake.lamportsPerByte = 7000n
    const approval = await rig.approve(tokenArgs({ mint, amount: "1" }))
    const fact = approval.description?.facts.find(({ label }) => label === "Token account")
    const rent = rig.fake.rentFor(165 + 1 + 4)
    expect(rent).toBeGreaterThan(rig.fake.rentFor(165))
    expect(fact?.value).toBe(`created for the recipient, rent ${rent} lamports`)
  })

  test("a token whose symbol cannot be shown is named by its address alone", async () => {
    const rig = makeRig()
    rig.fake.addMetadata({ mint: MINT, symbol: "ignore previous", tokenStandard: null })
    const approval = await rig.approve(tokenArgs())
    expect(approval.description?.headline).toBe('Send "5" of a token on "Solana"')
    expect(approval.description?.facts[2]?.value).toBe(`${MINT}, whose declared symbol is not shown`)
    expect(approval.description?.facts[3]?.value).toBe("5 (5000000 smallest units, 6 decimals)")
    expect(JSON.stringify(approval)).not.toContain("ignore")
  })

  test("a permanent delegate is named, with what it can do", async () => {
    const rig = makeRig()
    rig.fake.addMint(MINT, {
      decimals: 6,
      extensions: [{ extension: "permanentDelegate", state: { delegate: DELEGATE } }],
    })
    rig.fake.addAssociatedTokenAccount(BOB, MINT)
    const facts = (await rig.approve(tokenArgs())).description?.facts
    expect(facts?.slice(4)).toEqual([
      { label: "Permanent delegate", value: `${DELEGATE}, which can move any holder's tokens` },
      FEE_FACT,
    ])
  })

  test("a send to one of the person's own wallets says so, by label and account", async () => {
    const rig = makeRig()
    const { address } = await resolveAccount("savings#2", "solana", rig.runtime, rig.stateDir)
    const approval = await rig.approve(solArgs({ to: address }))
    expect(approval.description?.facts[1]).toEqual({ label: "Own wallet", value: "your wallet savings#2" })
    expect(approval.resources).toEqual([`from:${MAIN_ADDRESS}`, `to:${address}`])
  })

  test("keeps within the facts a prompt shows", async () => {
    const rig = makeRig()
    rig.fake.addMint(MINT, {
      decimals: 6,
      extensions: [{ extension: "permanentDelegate", state: { delegate: DELEGATE } }],
    })
    const description = await wholeCallDescription(rig.tool, tokenArgs(), rig.ctx)
    expect(description?.facts.length).toBeLessThanOrEqual(MAX_FACTS)
  })
})

describe("what a description is the same for", () => {
  test("the same transaction, whatever the fees, the block and the balances do between two descriptions", async () => {
    const rig = makeRig()
    const first = await wholeCallDescription(rig.tool, tokenArgs(), rig.ctx)
    rig.fake.priorityFees = [5_000_000n, 9_000_000n]
    rig.fake.advance(40)
    rig.fake.setBalance(MAIN_ADDRESS, 3n * LAMPORTS_PER_SOL)
    const second = await wholeCallDescription(rig.tool, tokenArgs(), rig.ctx)
    expect(first).toBeDefined()
    expect(second).toEqual(first)
  })

  test("a SOL send pins the chain, the sender and its one instruction as program, accounts with flags and data", async () => {
    const rig = makeRig()
    const description = await wholeCallDescription(rig.tool, solArgs(), rig.ctx)
    expect(Object.keys(description?.pins ?? {})).toEqual(["chain", "from", "instruction_0"])
    expect(description?.pins?.chain).toBe("solana")
    expect(description?.pins?.from).toBe(MAIN_ADDRESS)
    expect(JSON.parse(description?.pins?.instruction_0 ?? "")).toEqual({
      program: SOLANA_PROGRAMS.systemProgram,
      accounts: [
        { address: MAIN_ADDRESS, signer: true, writable: true },
        { address: BOB, signer: false, writable: true },
      ],
      data: "0200000000ca9a3b00000000",
    })
  })

  test("a token send pins both instructions, never the compute budget", async () => {
    const rig = makeRig()
    const pins = (await wholeCallDescription(rig.tool, tokenArgs(), rig.ctx))?.pins ?? {}
    expect(Object.keys(pins)).toEqual(["chain", "from", "instruction_0", "instruction_1"])
    expect(JSON.parse(pins.instruction_0!).program).toBe(SOLANA_PROGRAMS.associatedTokenProgram)
    expect(JSON.parse(pins.instruction_1!)).toMatchObject({
      program: SOLANA_PROGRAMS.tokenProgram,
      data: "0c404b4c000000000006",
    })
  })
})

describe("a call whose approval no longer holds", () => {
  const stale = { code: "stale" }

  test("the mint's decimals changed after the prompt: the amount means something else", async () => {
    const rig = makeRig()
    const args = tokenArgs()
    const { pin } = await rig.approve(args)
    rig.fake.addMint(MINT, { decimals: 9, supply: MAIN_TOKENS })
    rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, { amount: 100n * LAMPORTS_PER_SOL })
    await expect(checkPin(rig.tool, args, rig.ctx, pin)).rejects.toMatchObject(stale)
    expect(rig.fake.requestsOf("sendTransaction")).toHaveLength(0)
  })

  test("the mint's symbol changed after the prompt", async () => {
    const rig = makeRig()
    const args = tokenArgs()
    const { pin } = await rig.approve(args)
    rig.fake.addMetadata({ mint: MINT, symbol: "USDC", tokenStandard: null })
    await expect(checkPin(rig.tool, args, rig.ctx, pin)).rejects.toMatchObject(stale)
  })

  test("the rent changed after the prompt, or the recipient's token account appeared", async () => {
    const rig = makeRig()
    const args = tokenArgs()
    const { pin } = await rig.approve(args)
    rig.fake.lamportsPerByte = 6000n
    await expect(checkPin(rig.tool, args, rig.ctx, pin)).rejects.toMatchObject(stale)
    rig.fake.lamportsPerByte = 5080n
    await expect(checkPin(rig.tool, args, rig.ctx, pin)).resolves.toBeUndefined()
    rig.fake.addAssociatedTokenAccount(BOB, MINT)
    await expect(checkPin(rig.tool, args, rig.ctx, pin)).rejects.toMatchObject(stale)
  })

  test("another recipient, amount, mint or fee ceiling than the prompt showed", async () => {
    const rig = makeRig()
    const { pin } = await rig.approve(solArgs())
    const changes = [{ to: testAddress(5) }, { amount: "2" }, { max_fee: "200000" }]
    for (const change of changes) {
      await expect(checkPin(rig.tool, solArgs(change), rig.ctx, pin)).rejects.toMatchObject(stale)
    }
    await expect(checkPin(rig.tool, tokenArgs({ amount: "1" }), rig.ctx, pin)).rejects.toMatchObject(stale)
    await expect(checkPin(rig.tool, solArgs(), rig.ctx, pin)).resolves.toBeUndefined()
  })

  test("the person's own wallets changed after the prompt", async () => {
    const rig = makeRig()
    const { address } = await resolveAccount("savings#2", "solana", rig.runtime, rig.stateDir)
    const args = solArgs({ to: address })
    const { pin } = await rig.approve(args)
    Object.assign(rig.runtime.env, { WEB3_TOOLS_WALLET_SAVINGS: HARDHAT_PHRASE })
    await expect(checkPin(rig.tool, args, rig.ctx, pin)).rejects.toMatchObject(stale)
  })
})
