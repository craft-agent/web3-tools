import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { ALL_TOOLS } from "../../tools"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { holdsKeyMaterial } from "../signer/testing"
import { annotations } from "../tool"
import { associatedTokenAddress } from "./address"
import { web3SolanaRevoke } from "./revoke"
import { DELEGATE, makeRevokeRig, revokeArgs } from "./revoke.testing"
import { cleanRigs, LAMPORTS_PER_SOL, MAIN_ADDRESS, MAIN_TOKENS, MINT } from "./send.testing"
import { decodeTransaction } from "./testing.cluster.tx"

afterEach(cleanRigs)

const FEE = 5000n
const ACCOUNT = associatedTokenAddress(MAIN_ADDRESS, MINT, SOLANA_PROGRAMS.tokenProgram)

describe("web3SolanaRevoke", () => {
  test("is a write of the solana toolset that only lowers exposure, so its class is idempotent", () => {
    expect(web3SolanaRevoke).toMatchObject({ id: "web3_solana_revoke", toolset: "solana", class: "idempotent" })
    expect(web3SolanaRevoke.title).toBe("Revoke an approval")
    expect(web3SolanaRevoke.intent).not.toMatch(/[{}]/)
    expect(annotations(web3SolanaRevoke)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    })
  })

  test("declares the bounds a grant can limit, and is one of the package's tools", () => {
    expect(Object.keys(web3SolanaRevoke.bounds ?? {})).toEqual(["asset", "max_fee"])
    expect(ALL_TOOLS).toContain(web3SolanaRevoke)
  })

  test("says that a delegate on another token account of the wallet is not covered", () => {
    expect(web3SolanaRevoke.description).toMatch(/any other token account of the wallet is not covered/)
  })
})

describe("revoking a delegate", () => {
  test("clears it, settles the row confirmed and reports what it revoked", async () => {
    const rig = makeRevokeRig()
    const result = await rig.run(revokeArgs())

    const [row] = await rig.rows()
    expect(result).toEqual({
      chain: "solana",
      signature: row!.hash,
      outcome: "confirmed",
      ledger_row: row!.id,
      from: MAIN_ADDRESS,
      mint: MINT,
      delegate: DELEGATE,
      revoked: "delegate",
      slot: "2001",
      explorer: `https://explorer.solana.com/tx/${row!.hash}`,
    })
    expect(row).toMatchObject({
      family: "solana",
      chain: "solana",
      kind: "revoke",
      sender: MAIN_ADDRESS,
      recipient: DELEGATE,
      token: MINT,
      amount: "0",
      nonce: null,
      outcome: "confirmed",
    })
    expect(rig.fake.entryAt(ACCOUNT)).toMatchObject({ delegate: null, delegatedAmount: 0n, amount: MAIN_TOKENS })
    expect(rig.fake.balanceOf(MAIN_ADDRESS)).toBe(10n * LAMPORTS_PER_SOL - FEE)
  })

  test("signs the one Revoke of the token account, with the owner signing, whatever the delegate may still move", async () => {
    const rig = makeRevokeRig()
    await rig.run(revokeArgs())
    const instructions = decodeTransaction(rig.broadcasts()[0]!).message.instructions.slice(2)
    expect(instructions).toHaveLength(1)
    expect(instructions[0]).toMatchObject({
      programId: SOLANA_PROGRAMS.tokenProgram,
      accounts: [
        { address: ACCOUNT, signer: false, writable: true },
        { address: MAIN_ADDRESS, signer: true },
      ],
    })
    expect(Array.from(instructions[0]!.data)).toEqual([5])
  })

  test("of a Token-2022 mint goes through its own program and its own token account", async () => {
    const rig = makeRevokeRig()
    const token2022 = SOLANA_PROGRAMS.token2022Program
    rig.fake.addMint(MINT, { program: token2022, decimals: 6, supply: MAIN_TOKENS })
    const account = rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, { amount: 1n, delegate: DELEGATE })
    expect(account).toBe(associatedTokenAddress(MAIN_ADDRESS, MINT, token2022))
    expect((await rig.run(revokeArgs())).outcome).toBe("confirmed")
    expect(rig.fake.entryAt(account)).toMatchObject({ delegate: null })
    expect(decodeTransaction(rig.broadcasts()[0]!).message.instructions[2]).toMatchObject({ programId: token2022 })
  })

  test("asks no one: an idempotent write is covered by the harness's own approval", async () => {
    const rig = makeRevokeRig()
    const asked: string[] = []
    rig.ctx = {
      ...rig.ctx,
      confirm: async ({ message }) => {
        asked.push(message)
        return true
      },
    }
    expect((await rig.run(revokeArgs())).outcome).toBe("confirmed")
    expect(asked).toEqual([])
  })

  test("a failure on the cluster is failed, with the delegate left as it was", async () => {
    const rig = makeRevokeRig()
    rig.fake.revertWhen = () => true
    const result = await rig.run(revokeArgs())
    expect(result.outcome).toBe("failed")
    expect(rig.fake.entryAt(ACCOUNT)).toMatchObject({ delegate: DELEGATE, delegatedAmount: 50n })
  })
})

describe("what a revoke leaves behind", () => {
  test("no result, ledger row or error holds a key or the signed transaction", async () => {
    const rig = makeRevokeRig()
    const result = await rig.run(revokeArgs())
    expect(holdsKeyMaterial(result)).toBe(false)
    const raw = rig.broadcasts()[0]!
    expect(JSON.stringify(result)).not.toContain(raw)
    const file = readFileSync(`${rig.stateDir}/ledger/ledger.jsonl`, "utf8")
    expect(file).not.toContain(raw.slice(0, 80))
    expect(holdsKeyMaterial(file)).toBe(false)
    const error = await rig.run(revokeArgs()).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "invalid_argument" })
    expect(holdsKeyMaterial(error)).toBe(false)
    expect(String((error as Error).message)).not.toContain(raw.slice(0, 80))
  })
})
