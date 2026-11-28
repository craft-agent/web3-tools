import { beforeEach, describe, expect, test } from "bun:test"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { associatedTokenAddress } from "./address"
import { createIdempotentAta, revoke, setComputeUnitLimit, setComputeUnitPrice, transferChecked } from "./instructions"
import type { SolanaInstruction } from "./instructions"
import { simulate } from "./reads"
import { unsigned } from "./reads.fixtures"
import { FakeSolanaCluster, type LandedTransaction } from "./testing.cluster"
import { signedTransactionBase64, testKeypair, type TestKeypair } from "./testing.cluster.sign"
import { UNITS } from "./testing.cluster.programs"

const ALICE = testKeypair(1)
const BOB = testKeypair(2)
const CAROL = testKeypair(3)
const MINT = testKeypair(10).address

const TOKEN_PROGRAM: string = SOLANA_PROGRAMS.tokenProgram
const TOKEN_2022_PROGRAM: string = SOLANA_PROGRAMS.token2022Program

let cluster: FakeSolanaCluster
let aliceAta: string

async function run(
  instructions: SolanaInstruction[],
  payer: TestKeypair = ALICE,
  ...rest: TestKeypair[]
): Promise<LandedTransaction> {
  const message = { feePayer: payer.address, recentBlockhash: cluster.latestBlockhash, instructions }
  await cluster
    .client()
    .call("sendTransaction", [signedTransactionBase64(message, payer, ...rest), { encoding: "base64" }])
  return cluster.land()[0]
}

const send = (amount: bigint, from: string, to: string, owner = ALICE, program = TOKEN_PROGRAM, decimals = 6) =>
  transferChecked(program, from, MINT, to, owner.address, amount, decimals)

const customError = (index: number, code: number) => ({ InstructionError: [index, { Custom: code }] })

beforeEach(() => {
  cluster = new FakeSolanaCluster().setBalance(ALICE.address, 10_000_000n).setBalance(BOB.address, 10_000_000n)
  cluster.addMint(MINT, { decimals: 6, supply: 5_000n })
  aliceAta = cluster.addAssociatedTokenAccount(ALICE.address, MINT, { amount: 1_000n })
})

describe("CreateIdempotent and TransferChecked in the fake", () => {
  test("creates the recipient's associated token account, which the payer funds with its rent, and moves the tokens", async () => {
    const bobAta = associatedTokenAddress(BOB.address, MINT, TOKEN_PROGRAM)
    const landed = await run([
      createIdempotentAta(ALICE.address, bobAta, BOB.address, MINT, TOKEN_PROGRAM),
      send(300n, aliceAta, bobAta),
    ])
    expect(landed).toMatchObject({ err: null, unitsConsumed: UNITS.createAta + UNITS.transferChecked, fee: 5000n })
    expect(cluster.entryAt(bobAta)).toMatchObject({
      kind: "token",
      owner: TOKEN_PROGRAM,
      holder: BOB.address,
      mint: MINT,
      space: 165,
      lamports: 1_488_440n,
      state: "initialized",
      amount: 300n,
    })
    expect(cluster.tokenBalanceOf(aliceAta)).toBe(700n)
    expect(cluster.balanceOf(ALICE.address)).toBe(10_000_000n - 1_488_440n - 5000n)
  })

  test("does nothing when the account exists, and a second send then costs fewer units", async () => {
    const bobAta = associatedTokenAddress(BOB.address, MINT, TOKEN_PROGRAM)
    await run([createIdempotentAta(ALICE.address, bobAta, BOB.address, MINT, TOKEN_PROGRAM)])
    const before = cluster.balanceOf(ALICE.address)
    const landed = await run([createIdempotentAta(ALICE.address, bobAta, BOB.address, MINT, TOKEN_PROGRAM)])
    expect(landed).toMatchObject({ err: null, unitsConsumed: UNITS.existingAta })
    expect(cluster.balanceOf(ALICE.address)).toBe(before - 5000n)
  })

  test("a Token-2022 account has the space of its immutable owner extension and is rent-exempt for it", async () => {
    const mint = testKeypair(11).address
    cluster.addMint(mint, { program: TOKEN_2022_PROGRAM, decimals: 2 })
    const ata = associatedTokenAddress(BOB.address, mint, TOKEN_2022_PROGRAM)
    await run([createIdempotentAta(ALICE.address, ata, BOB.address, mint, TOKEN_2022_PROGRAM)])
    expect(cluster.entryAt(ata)).toMatchObject({
      owner: TOKEN_2022_PROGRAM,
      space: 170,
      lamports: cluster.rentFor(170),
      extensions: [{ extension: "immutableOwner" }],
    })
  })

  test("an account of a mint whose new accounts start frozen is frozen, and a transfer into it fails", async () => {
    const mint = testKeypair(11).address
    cluster.addMint(mint, {
      program: TOKEN_2022_PROGRAM,
      extensions: [{ extension: "defaultAccountState", state: { accountState: "frozen" } }],
    })
    const source = cluster.addAssociatedTokenAccount(ALICE.address, mint, { amount: 50n })
    const ata = associatedTokenAddress(BOB.address, mint, TOKEN_2022_PROGRAM)
    const landed = await run([
      createIdempotentAta(ALICE.address, ata, BOB.address, mint, TOKEN_2022_PROGRAM),
      transferChecked(TOKEN_2022_PROGRAM, source, mint, ata, ALICE.address, 5n, 6),
    ])
    expect(landed.err).toEqual(customError(1, 17))
    expect(cluster.entryAt(ata)).toBeUndefined()
  })

  test("an address that is not the derived one, an account of another owner and a payer that cannot pay are refused", async () => {
    const bobAta = associatedTokenAddress(BOB.address, MINT, TOKEN_PROGRAM)
    const wrong = await run([
      createIdempotentAta(
        ALICE.address,
        associatedTokenAddress(CAROL.address, MINT, TOKEN_PROGRAM),
        BOB.address,
        MINT,
        TOKEN_PROGRAM,
      ),
    ])
    expect(wrong.err).toEqual({ InstructionError: [0, "InvalidSeeds"] })
    const existing = await run([createIdempotentAta(ALICE.address, aliceAta, ALICE.address, MINT, TOKEN_PROGRAM)])
    expect(existing.err).toBeNull()
    cluster.addTokenAccount(bobAta, MINT, CAROL.address)
    const taken = await run([createIdempotentAta(ALICE.address, bobAta, BOB.address, MINT, TOKEN_PROGRAM)])
    expect(taken.err).toEqual({ InstructionError: [0, "IllegalOwner"] })
    cluster.setBalance(CAROL.address, 1_000_000n)
    const carolAta = associatedTokenAddress(CAROL.address, testKeypair(12).address, TOKEN_PROGRAM)
    cluster.addMint(testKeypair(12).address)
    const broke = await run(
      [createIdempotentAta(CAROL.address, carolAta, CAROL.address, testKeypair(12).address, TOKEN_PROGRAM)],
      CAROL,
    )
    expect(broke.err).toEqual(customError(0, 1))
    expect(cluster.entryAt(carolAta)).toBeUndefined()
  })

  test("a mint that is not one of the program's is refused", async () => {
    const ata = associatedTokenAddress(BOB.address, MINT, TOKEN_2022_PROGRAM)
    expect((await run([createIdempotentAta(ALICE.address, ata, BOB.address, MINT, TOKEN_2022_PROGRAM)])).err).toEqual({
      InstructionError: [0, "IncorrectProgramId"],
    })
    const none = testKeypair(13).address
    const ataOfNone = associatedTokenAddress(BOB.address, none, TOKEN_PROGRAM)
    expect((await run([createIdempotentAta(ALICE.address, ataOfNone, BOB.address, none, TOKEN_PROGRAM)])).err).toEqual({
      InstructionError: [0, "InvalidAccountData"],
    })
  })

  test("an address funded with lamports already is topped up to the rent, not charged twice", async () => {
    const bobAta = associatedTokenAddress(BOB.address, MINT, TOKEN_PROGRAM)
    cluster.setBalance(bobAta, 400_000n)
    await run([createIdempotentAta(ALICE.address, bobAta, BOB.address, MINT, TOKEN_PROGRAM)])
    expect(cluster.entryAt(bobAta)).toMatchObject({ kind: "token", lamports: 1_488_440n })
    expect(cluster.balanceOf(ALICE.address)).toBe(10_000_000n - 1_088_440n - 5000n)
  })
})

describe("TransferChecked's refusals in the fake", () => {
  let bobAta: string

  beforeEach(() => {
    bobAta = cluster.addAssociatedTokenAccount(BOB.address, MINT, { amount: 10n })
  })

  test("a transfer within the balance moves the tokens and leaves the supply as it is", async () => {
    expect((await run([send(1_000n, aliceAta, bobAta)])).err).toBeNull()
    expect(cluster.tokenBalanceOf(aliceAta)).toBe(0n)
    expect(cluster.tokenBalanceOf(bobAta)).toBe(1_010n)
    expect(cluster.entryAt(MINT)).toMatchObject({ supply: 5_000n })
  })

  test("more than the balance, wrong decimals and another mint are refused with the token program's own errors", async () => {
    expect((await run([send(1_001n, aliceAta, bobAta)])).err).toEqual(customError(0, 1))
    expect((await run([send(1n, aliceAta, bobAta, ALICE, TOKEN_PROGRAM, 5)])).err).toEqual(customError(0, 18))
    const other = testKeypair(14).address
    cluster.addMint(other)
    const elsewhere = cluster.addAssociatedTokenAccount(BOB.address, other)
    expect((await run([send(1n, aliceAta, elsewhere)])).err).toEqual(customError(0, 3))
    expect(cluster.tokenBalanceOf(aliceAta)).toBe(1_000n)
  })

  test("a frozen source or destination is refused", async () => {
    cluster.addTokenAccount(aliceAta, MINT, ALICE.address, { amount: 1_000n, state: "frozen" })
    expect((await run([send(1n, aliceAta, bobAta)])).err).toEqual(customError(0, 17))
    cluster.addTokenAccount(aliceAta, MINT, ALICE.address, { amount: 1_000n })
    cluster.addTokenAccount(bobAta, MINT, BOB.address, { state: "frozen" })
    expect((await run([send(1n, aliceAta, bobAta)])).err).toEqual(customError(0, 17))
  })

  test("an owner other than the source's is refused, and so is an account of the other token program", async () => {
    expect((await run([send(1n, aliceAta, bobAta, BOB)], BOB)).err).toEqual(customError(0, 4))
    expect((await run([send(1n, aliceAta, bobAta, ALICE, TOKEN_2022_PROGRAM)])).err).toEqual({
      InstructionError: [0, "IncorrectProgramId"],
    })
    expect((await run([send(1n, testKeypair(15).address, bobAta)])).err).toEqual({
      InstructionError: [0, "InvalidAccountData"],
    })
  })

  test("a delegate may move up to what it was delegated, each move uses it up, and the last clears it", async () => {
    cluster.addTokenAccount(aliceAta, MINT, ALICE.address, {
      amount: 1_000n,
      delegate: CAROL.address,
      delegatedAmount: 300n,
    })
    cluster.setBalance(CAROL.address, 1_000_000n)
    expect((await run([send(200n, aliceAta, bobAta, CAROL)], CAROL)).err).toBeNull()
    expect(cluster.entryAt(aliceAta)).toMatchObject({ amount: 800n, delegate: CAROL.address, delegatedAmount: 100n })
    expect((await run([send(101n, aliceAta, bobAta, CAROL)], CAROL)).err).toEqual(customError(0, 1))
    expect((await run([send(100n, aliceAta, bobAta, CAROL)], CAROL)).err).toBeNull()
    expect(cluster.entryAt(aliceAta)).toMatchObject({ amount: 700n, delegate: null, delegatedAmount: 0n })
    expect((await run([send(1n, aliceAta, bobAta, CAROL)], CAROL)).err).toEqual(customError(0, 4))
  })
})

describe("Revoke in the fake", () => {
  test("clears the delegate and what it was delegated, and only the owner may", async () => {
    cluster.addTokenAccount(aliceAta, MINT, ALICE.address, {
      amount: 1_000n,
      delegate: CAROL.address,
      delegatedAmount: 300n,
    })
    expect((await run([revoke(TOKEN_PROGRAM, aliceAta, BOB.address)], BOB)).err).toEqual(customError(0, 4))
    const landed = await run([revoke(TOKEN_PROGRAM, aliceAta, ALICE.address)])
    expect(landed).toMatchObject({ err: null, unitsConsumed: UNITS.revoke })
    expect(cluster.entryAt(aliceAta)).toMatchObject({ amount: 1_000n, delegate: null, delegatedAmount: 0n })
  })

  test("a frozen account cannot be revoked", async () => {
    cluster.addTokenAccount(aliceAta, MINT, ALICE.address, {
      delegate: CAROL.address,
      delegatedAmount: 5n,
      state: "frozen",
    })
    expect((await run([revoke(TOKEN_PROGRAM, aliceAta, ALICE.address)])).err).toEqual(customError(0, 17))
  })
})

describe("a dry run in the fake", () => {
  test("reports the units each instruction takes, and changes nothing", async () => {
    const bobAta = associatedTokenAddress(BOB.address, MINT, TOKEN_PROGRAM)
    const budget = [setComputeUnitLimit(1_400_000), setComputeUnitPrice(0n)]
    const instructions = [
      ...budget,
      createIdempotentAta(ALICE.address, bobAta, BOB.address, MINT, TOKEN_PROGRAM),
      send(1n, aliceAta, bobAta),
      revoke(TOKEN_PROGRAM, aliceAta, ALICE.address),
    ]
    const message = { feePayer: ALICE.address, recentBlockhash: cluster.latestBlockhash, instructions }
    const { unitsConsumed } = await simulate(cluster.client(), unsigned(message))
    expect(unitsConsumed).toBe(2 * UNITS.budget + UNITS.createAta + UNITS.transferChecked + UNITS.revoke)
    expect(cluster.entryAt(bobAta)).toBeUndefined()
    expect(cluster.tokenBalanceOf(aliceAta)).toBe(1_000n)
    expect(cluster.balanceOf(ALICE.address)).toBe(10_000_000n)
  })

  test("reports the error a landing would, without landing it", async () => {
    const bobAta = cluster.addAssociatedTokenAccount(BOB.address, MINT)
    const message = {
      feePayer: ALICE.address,
      recentBlockhash: cluster.latestBlockhash,
      instructions: [send(2_000n, aliceAta, bobAta)],
    }
    const error = await simulate(cluster.client(), unsigned(message)).catch((caught: Error) => caught)
    expect((error as Error).message).toContain('{"InstructionError":[0,{"Custom":1}]}')
    expect((error as Error).message).toContain("Program log: Error: insufficient funds")
    expect(cluster.pending).toHaveLength(0)
  })
})
