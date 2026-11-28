import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { holdsKeyMaterial } from "../signer/testing"
import { annotations } from "../tool"
import { associatedTokenAddress } from "./address"
import { web3SolanaSend } from "./send"
import { testAddress } from "./testing"
import { decodeTransaction } from "./testing.cluster.tx"
import {
  BOB,
  cleanRigs,
  LAMPORTS_PER_SOL,
  MAIN_ADDRESS,
  MAIN_TOKENS,
  makeRig,
  MINT,
  signaturesOf,
  solArgs,
  tokenArgs,
} from "./send.testing"

afterEach(cleanRigs)

const FEE = 5000n

describe("web3SolanaSend", () => {
  test("is an administrative write of the solana toolset", () => {
    expect(web3SolanaSend).toMatchObject({ id: "web3_solana_send", toolset: "solana", class: "administrative" })
    expect(annotations(web3SolanaSend)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })
    expect(web3SolanaSend.intent).not.toMatch(/[{}]/)
  })

  test("declares the bounds a grant can limit", () => {
    expect(Object.keys(web3SolanaSend.bounds ?? {})).toEqual(["asset", "recipient", "amount", "max_fee"])
  })
})

describe("a SOL send", () => {
  test("moves the coin, settles the ledger row confirmed and reports what it sent", async () => {
    const rig = makeRig()
    const result = await rig.run(solArgs({ amount: "1.5" }))

    const [row] = await rig.rows()
    expect(result).toEqual({
      chain: "solana",
      signature: row!.hash,
      outcome: "confirmed",
      ledger_row: row!.id,
      from: MAIN_ADDRESS,
      to: BOB,
      mint: null,
      amount: "1.5",
      symbol: "SOL",
      slot: "2001",
      explorer: `https://explorer.solana.com/tx/${row!.hash}`,
    })
    expect(row).toMatchObject({
      family: "solana",
      chain: "solana",
      sender: MAIN_ADDRESS,
      recipient: BOB,
      kind: "sol",
      token: null,
      amount: String((3n * LAMPORTS_PER_SOL) / 2n),
      nonce: null,
      last_valid_height: "1150",
      outcome: "confirmed",
      block: "2001",
    })
    expect(signaturesOf(rig)).toEqual([row!.hash])
    expect(rig.fake.balanceOf(BOB)).toBe((3n * LAMPORTS_PER_SOL) / 2n)
    expect(rig.fake.balanceOf(MAIN_ADDRESS)).toBe(10n * LAMPORTS_PER_SOL - (3n * LAMPORTS_PER_SOL) / 2n - FEE)
  })

  test("links the devnet explorer to its cluster", async () => {
    const rig = makeRig({ chain: "solana-devnet" })
    const result = await rig.run(solArgs({ chain: "solana-devnet" }))
    expect(result.explorer).toBe(`https://explorer.solana.com/tx/${result.signature}?cluster=devnet`)
    expect(result.chain).toBe("solana-devnet")
  })

  test("a transaction that fails on the cluster is failed, with its fee spent and nothing moved", async () => {
    const rig = makeRig()
    rig.fake.revertWhen = () => true
    const result = await rig.run(solArgs())
    expect(result).toMatchObject({ outcome: "failed", slot: "2001" })
    expect((await rig.rows())[0]).toMatchObject({ outcome: "failed", block: "2001" })
    expect(rig.fake.balanceOf(BOB)).toBe(0n)
    expect(rig.fake.balanceOf(MAIN_ADDRESS)).toBe(10n * LAMPORTS_PER_SOL - FEE)
  })

  test("a send to a wallet that exists adds to it, however little", async () => {
    const rig = makeRig()
    rig.fake.setBalance(BOB, LAMPORTS_PER_SOL)
    expect((await rig.run(solArgs({ amount: "0.000000001" }))).outcome).toBe("confirmed")
    expect(rig.fake.balanceOf(BOB)).toBe(LAMPORTS_PER_SOL + 1n)
  })
})

describe("a token send", () => {
  test("to a token account that exists moves the tokens and the ledger row names the mint", async () => {
    const rig = makeRig()
    const bobAccount = rig.fake.addAssociatedTokenAccount(BOB, MINT, { amount: 7n })
    const result = await rig.run(tokenArgs({ amount: "2.5" }))

    expect(result).toMatchObject({ outcome: "confirmed", mint: MINT, amount: "2.5", symbol: "TKN", to: BOB })
    expect(rig.fake.tokenBalanceOf(bobAccount)).toBe(2_500_007n)
    expect(rig.fake.tokenBalanceOf(associatedTokenAddress(MAIN_ADDRESS, MINT, SOLANA_PROGRAMS.tokenProgram))).toBe(
      MAIN_TOKENS - 2_500_000n,
    )
    expect((await rig.rows())[0]).toMatchObject({ kind: "spl", token: MINT, amount: "2500000", recipient: BOB })
    expect(rig.fake.balanceOf(MAIN_ADDRESS)).toBe(10n * LAMPORTS_PER_SOL - FEE)
  })

  test("to a wallet with no token account makes it, and the sender pays its rent", async () => {
    const rig = makeRig()
    const result = await rig.run(tokenArgs())
    const created = associatedTokenAddress(BOB, MINT, SOLANA_PROGRAMS.tokenProgram)
    const rent = rig.fake.rentFor(165)

    expect(result.outcome).toBe("confirmed")
    expect(rig.fake.tokenBalanceOf(created)).toBe(5_000_000n)
    expect(rig.fake.entryAt(created)).toMatchObject({ kind: "token", holder: BOB, lamports: rent })
    expect(rig.fake.balanceOf(MAIN_ADDRESS)).toBe(10n * LAMPORTS_PER_SOL - FEE - rent)
    expect(rig.fake.balanceOf(BOB)).toBe(0n)
  })

  test("signs the same two instructions whether or not the token account exists", async () => {
    const missing = makeRig()
    await missing.run(tokenArgs())
    const existing = makeRig()
    existing.fake.addAssociatedTokenAccount(BOB, MINT)
    await existing.run(tokenArgs())
    const signed = (rig: typeof missing) => decodeTransaction(rig.broadcasts()[0]!).message.instructions.slice(2)
    expect(signed(missing)).toHaveLength(2)
    expect(signed(missing)).toEqual(signed(existing))
  })

  test("a Token-2022 mint is sent under its own program", async () => {
    const rig = makeRig()
    const token2022 = SOLANA_PROGRAMS.token2022Program
    const mint = testAddress(4)
    rig.fake.addMint(mint, { program: token2022, decimals: 9 })
    const source = rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, mint, { amount: 10n * LAMPORTS_PER_SOL })
    const result = await rig.run(tokenArgs({ mint, amount: "2" }))

    const created = associatedTokenAddress(BOB, mint, token2022)
    expect(result).toMatchObject({ outcome: "confirmed", mint, symbol: null })
    expect(rig.fake.tokenBalanceOf(created)).toBe(2n * LAMPORTS_PER_SOL)
    expect(rig.fake.tokenBalanceOf(source)).toBe(8n * LAMPORTS_PER_SOL)
    expect(rig.fake.entryAt(created)).toMatchObject({ owner: token2022 })
  })

  test("a mint with a permanent delegate is sent too, once the prompt has named it", async () => {
    const rig = makeRig()
    rig.fake.addMint(MINT, {
      decimals: 6,
      extensions: [{ extension: "permanentDelegate", state: { delegate: testAddress(9) } }],
    })
    expect((await rig.run(tokenArgs())).outcome).toBe("confirmed")
  })
})

describe("what a send leaves behind", () => {
  test("no result, error or ledger file holds a key or the signed transaction", async () => {
    const rig = makeRig()
    const result = await rig.run(solArgs())
    expect(holdsKeyMaterial(result)).toBe(false)
    const raw = rig.broadcasts()[0]!
    expect(JSON.stringify(result)).not.toContain(raw)
    const file = readFileSync(`${rig.stateDir}/ledger/ledger.jsonl`, "utf8")
    expect(file).not.toContain(raw)
    expect(file).not.toContain(raw.slice(0, 80))
    expect(holdsKeyMaterial(file)).toBe(false)
  })
})

describe("asking the person", () => {
  test("asks for an administrative write with what will be sent, and goes on when the answer is yes", async () => {
    const rig = makeRig()
    const asked: string[] = []
    rig.ctx = {
      ...rig.ctx,
      confirm: async ({ tool, message }) => {
        asked.push(`${tool}: ${message}`)
        return true
      },
    }
    expect((await rig.run(tokenArgs())).outcome).toBe("confirmed")
    expect(asked).toEqual([
      `web3_solana_send: Send 5 TKN (mint ${MINT}) on Solana from ${MAIN_ADDRESS} to ${BOB}, with a fee of at most 100000 lamports`,
    ])
  })

  test("sends nothing and writes no row when the answer is no", async () => {
    const rig = makeRig()
    rig.ctx = { ...rig.ctx, confirm: async () => false }
    await expect(rig.run(solArgs())).rejects.toMatchObject({ code: "declined" })
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })

  test("sends nothing when what was asked about changed while the person answered", async () => {
    const rig = makeRig()
    rig.ctx = {
      ...rig.ctx,
      confirm: async () => {
        rig.fake.addMint(MINT, { decimals: 9, supply: MAIN_TOKENS })
        rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, { amount: 100n * LAMPORTS_PER_SOL })
        return true
      },
    }
    await expect(rig.invoke(tokenArgs())).rejects.toMatchObject({ code: "stale" })
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })
})
