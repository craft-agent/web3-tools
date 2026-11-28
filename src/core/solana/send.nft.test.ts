import { afterEach, describe, expect, test } from "bun:test"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { associatedTokenAddress } from "./address"
import {
  addNft,
  BOB,
  cleanRigs,
  expectRefused,
  LAMPORTS_PER_SOL,
  MAIN_ADDRESS,
  makeRig,
  NFT_MINT,
  nftArgs,
  signaturesOf,
  type NftInit,
  tokenArgs,
} from "./send.testing"
import { testAddress } from "./testing"
import { decodeTransaction } from "./testing.cluster.tx"
import { TOKEN_STANDARDS } from "./token-rules"

afterEach(cleanRigs)

const FEE = 5000n
const CANNOT_SEND = "invalid_argument"
const SENDER_ACCOUNT = associatedTokenAddress(MAIN_ADDRESS, NFT_MINT, SOLANA_PROGRAMS.tokenProgram)
const BOB_ACCOUNT = associatedTokenAddress(BOB, NFT_MINT, SOLANA_PROGRAMS.tokenProgram)

describe("a plain NFT send", () => {
  test("moves the NFT, makes the recipient's token account at the sender's cost and records an nft row", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    const result = await rig.run(nftArgs())

    const [row] = await rig.rows()
    const rent = rig.fake.rentFor(165)
    expect(result).toEqual({
      chain: "solana",
      signature: row!.hash,
      outcome: "confirmed",
      ledger_row: row!.id,
      from: MAIN_ADDRESS,
      to: BOB,
      mint: NFT_MINT,
      nft: true,
      amount: "1",
      symbol: "APE",
      slot: "2001",
      explorer: `https://explorer.solana.com/tx/${row!.hash}`,
    })
    expect(row).toMatchObject({ kind: "nft", token: NFT_MINT, amount: "1", recipient: BOB, sender: MAIN_ADDRESS })
    expect(rig.fake.tokenBalanceOf(SENDER_ACCOUNT)).toBe(0n)
    expect(rig.fake.tokenBalanceOf(BOB_ACCOUNT)).toBe(1n)
    expect(rig.fake.entryAt(BOB_ACCOUNT)).toMatchObject({ kind: "token", holder: BOB, lamports: rent })
    expect(rig.fake.balanceOf(MAIN_ADDRESS)).toBe(10n * LAMPORTS_PER_SOL - FEE - rent)
    expect(signaturesOf(rig)).toEqual([row!.hash])
  })

  test("signs a transfer of 1 to the recipient's associated token account, which it creates idempotently", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    await rig.run(nftArgs())
    const [create, transfer] = decodeTransaction(rig.broadcasts()[0]!).message.instructions.slice(2)
    expect(create).toMatchObject({ programId: SOLANA_PROGRAMS.associatedTokenProgram })
    expect(Array.from(create!.data)).toEqual([1])
    expect(transfer).toMatchObject({ programId: SOLANA_PROGRAMS.tokenProgram })
    expect(Array.from(transfer!.data)).toEqual([12, 1, 0, 0, 0, 0, 0, 0, 0, 0])
  })

  test("to a wallet that already has the token account moves it without creating one", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    rig.fake.addAssociatedTokenAccount(BOB, NFT_MINT)
    expect((await rig.run(nftArgs())).outcome).toBe("confirmed")
    expect(rig.fake.tokenBalanceOf(BOB_ACCOUNT)).toBe(1n)
    expect(rig.fake.balanceOf(MAIN_ADDRESS)).toBe(10n * LAMPORTS_PER_SOL - FEE)
  })

  const plain: [string, NftInit][] = [
    ["an edition", { standard: TOKEN_STANDARDS.nonFungibleEdition }],
    ["an account made before token standards", { standard: null }],
    ["a mint with no metadata account", { metadata: false }],
  ]

  test.each(plain)("%s is sent as a plain NFT", async (_name, init) => {
    const rig = makeRig()
    addNft(rig.fake, init)
    const result = await rig.run(nftArgs())
    expect(result).toMatchObject({ outcome: "confirmed", nft: true, symbol: init.metadata === false ? null : "APE" })
    expect(rig.fake.tokenBalanceOf(BOB_ACCOUNT)).toBe(1n)
  })

  test("a mint of the NFT's shape whose standard is fungible is sent as a token, with a token row", async () => {
    const rig = makeRig()
    addNft(rig.fake, { standard: TOKEN_STANDARDS.fungible })
    const result = await rig.run(tokenArgs({ mint: NFT_MINT, amount: "1" }))
    expect(result).toMatchObject({ outcome: "confirmed", nft: false, amount: "1", mint: NFT_MINT })
    expect((await rig.rows())[0]).toMatchObject({ kind: "spl", amount: "1" })
    expect(rig.fake.tokenBalanceOf(BOB_ACCOUNT)).toBe(1n)
  })

  test("a token of 6 decimals is not an NFT, whatever its supply", async () => {
    const result = await makeRig().run(tokenArgs())
    expect(result.nft).toBe(false)
  })
})

describe("an NFT that is refused before anyone is asked", () => {
  test.each([
    ["a programmable NFT", TOKEN_STANDARDS.programmableNonFungible],
    ["a programmable edition", TOKEN_STANDARDS.programmableNonFungibleEdition],
  ])("%s", async (_name, standard) => {
    const rig = makeRig()
    addNft(rig.fake, { standard })
    await expectRefused(rig, nftArgs(), CANNOT_SEND, /programmable NFT.*Token Metadata's own instruction/)
  })

  test("a token standard these tools do not know", async () => {
    const rig = makeRig()
    addNft(rig.fake, { standard: 9 })
    await expectRefused(rig, nftArgs(), CANNOT_SEND, /token standard 9/)
  })

  test.each(["2", "0", "1.5", "1.0"])("an amount of %s, as an NFT is sent whole", async (amount) => {
    const rig = makeRig()
    addNft(rig.fake)
    await expectRefused(rig, nftArgs({ amount }), CANNOT_SEND, /amount/)
    expect(rig.fake.tokenBalanceOf(SENDER_ACCOUNT)).toBe(1n)
  })

  test("an amount of 2 names what an NFT takes", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    await expectRefused(rig, nftArgs({ amount: "2" }), CANNOT_SEND, /An NFT is sent whole: amount must be "1"/)
  })

  test("an NFT the wallet has no token account for", async () => {
    const rig = makeRig()
    addNft(rig.fake, { held: null })
    await expectRefused(rig, nftArgs(), CANNOT_SEND, /holds none of the token/)
  })

  test("an NFT the wallet's token account no longer holds", async () => {
    const rig = makeRig()
    addNft(rig.fake, { held: 0n })
    await expectRefused(rig, nftArgs(), CANNOT_SEND, /holds 0 of the token.*less than the 1 to send/)
  })

  test("a frozen token account, as the token rules say", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, NFT_MINT, { amount: 1n, state: "frozen" })
    await expectRefused(rig, nftArgs(), CANNOT_SEND, /source token account is frozen/)
  })

  test("a token extension the rules refuse, on an NFT as on any token", async () => {
    const rig = makeRig()
    addNft(rig.fake)
    rig.fake.addMint(NFT_MINT, { decimals: 0, supply: 1n, extensions: [{ extension: "nonTransferable" }] })
    await expectRefused(rig, nftArgs(), CANNOT_SEND, /cannot be transferred/)
  })

  test("a compressed NFT or a Core asset has no mint: no account, or one no token program owns", async () => {
    const message = /a compressed NFT or a Core asset has no SPL mint and is not sent/
    await expectRefused(makeRig(), nftArgs({ mint: testAddress(7) }), CANNOT_SEND, message)
    await expectRefused(makeRig(), nftArgs({ mint: MAIN_ADDRESS }), CANNOT_SEND, message)
  })
})
