import { describe, expect, test } from "bun:test"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { toolError } from "../rpc/client.fixtures"
import { associatedTokenAddress, metadataAddress } from "./address"
import { testAddress } from "./testing"
import { FakeSolanaCluster } from "./testing.cluster"
import { testKeypair } from "./testing.cluster.sign"

const ALICE = testAddress(1)
const BOB = testAddress(2)
const MINT = testAddress(3)

describe("the fake cluster's reads", () => {
  test("answers the height, the blockhash, the balance and the rent like a node", async () => {
    const cluster = new FakeSolanaCluster("solana", { blockHeight: 7_000n }).setBalance(ALICE, 12_345n)
    const client = cluster.client()
    expect(await client.call("getBlockHeight")).toBe(7_000)
    expect(await client.call("getLatestBlockhash")).toEqual({
      context: { apiVersion: "fake", slot: 8_000 },
      value: { blockhash: cluster.latestBlockhash, lastValidBlockHeight: 7_150 },
    })
    expect(await client.call("getBalance", [ALICE])).toMatchObject({ value: 12_345 })
    expect(await client.call("getBalance", [BOB])).toMatchObject({ value: 0 })
    expect(await client.call("getMinimumBalanceForRentExemption", [0])).toBe(650_240)
    expect(await client.call("getMinimumBalanceForRentExemption", [165])).toBe(1_488_440)
  })

  test("the rent is configurable, and the blockhash rolls with the height and is the same for the same height", () => {
    const cluster = new FakeSolanaCluster()
    expect(cluster.rentFor(100)).toBe(228n * 5080n)
    cluster.lamportsPerByte = 6960n
    expect(cluster.rentFor(165)).toBe(2_039_280n)
    const before = cluster.latestBlockhash
    expect(cluster.latestBlockhash).toBe(before)
    cluster.advance(1)
    expect(cluster.latestBlockhash).not.toBe(before)
    expect(new FakeSolanaCluster().latestBlockhash).toBe(before)
  })

  test("answers recent prioritization fees from the fees it was given, newest block first", async () => {
    const cluster = new FakeSolanaCluster()
    cluster.priorityFees = [0n, 700n]
    expect(await cluster.client().call("getRecentPrioritizationFees", [[ALICE]])).toEqual([
      { slot: 1000 + 1000, prioritizationFee: 0 },
      { slot: 1000 + 999, prioritizationFee: 700 },
    ])
  })

  test("answers an account as jsonParsed, as a node does, and as base64", async () => {
    const cluster = new FakeSolanaCluster()
      .addMint(MINT, { decimals: 6, supply: 10n ** 12n, freezeAuthority: BOB })
      .setBalance(ALICE, 1n)
    const client = cluster.client()
    const parsed = await client.call<{ value: Record<string, unknown> }>("getAccountInfo", [
      MINT,
      { encoding: "jsonParsed" },
    ])
    expect(parsed.value).toMatchObject({
      owner: SOLANA_PROGRAMS.tokenProgram,
      executable: false,
      lamports: 1_066_800,
      space: 82,
      data: {
        program: "spl-token",
        space: 82,
        parsed: {
          type: "mint",
          info: { decimals: 6, supply: "1000000000000", freezeAuthority: BOB, isInitialized: true },
        },
      },
    })
    const raw = await client.call<{ value: { data: [string, string] } }>("getAccountInfo", [
      MINT,
      { encoding: "base64" },
    ])
    expect(raw.value.data[1]).toBe("base64")
    expect(Buffer.from(raw.value.data[0], "base64")).toHaveLength(82)
    expect(Buffer.from(raw.value.data[0], "base64")[44]).toBe(6)
    const wallet = await client.call<{ value: { data: unknown } }>("getAccountInfo", [
      ALICE,
      { encoding: "jsonParsed" },
    ])
    expect(wallet.value.data).toEqual(["", "base64"])
    expect(await client.call("getAccountInfo", [BOB, { encoding: "base64" }])).toMatchObject({ value: null })
  })

  test("refuses an encoding it does not serve, and an unknown method, as a node does", async () => {
    const client = new FakeSolanaCluster().client()
    expect((await toolError(client.call("getAccountInfo", [ALICE, { encoding: "base58" }]))).message).toContain(
      "jsonParsed",
    )
    expect((await toolError(client.call("getSlotLeader"))).message).toContain("Method not found")
  })

  test("records every request, and `inject` answers the next one of a method differently", async () => {
    const cluster = new FakeSolanaCluster().setBalance(ALICE, 1n)
    cluster.inject("getBalance", { result: { value: 9 } }).inject("getBalance", { http: { status: 500 } })
    const client = cluster.client()
    expect(await client.call("getBalance", [ALICE])).toEqual({ value: 9 })
    expect((await toolError(client.call("getBalance", [ALICE]))).code).toBe("upstream_error")
    expect(await client.call("getBalance", [ALICE])).toMatchObject({ value: 1 })
    expect(cluster.requestsOf("getBalance")).toHaveLength(3)
  })

  test("a request `inject`ed to time out never answers, so the client times out", async () => {
    const cluster = new FakeSolanaCluster()
    cluster.inject("getBlockHeight", "timeout")
    expect((await toolError(cluster.client({ timeoutMs: 20 }).call("getBlockHeight"))).message).toContain(
      "did not answer",
    )
  })

  test("takes its cluster from the table, and rejects a key that is not in it", () => {
    expect(new FakeSolanaCluster("solana-devnet").chain.cluster).toBe("devnet")
    expect(() => new FakeSolanaCluster("nowhere")).toThrow()
  })
})

describe("the fake cluster's setup", () => {
  test("setBalance makes a wallet, changes any account, and a balance of 0 is no account", () => {
    const cluster = new FakeSolanaCluster().setBalance(ALICE, 500n)
    expect(cluster.entryAt(ALICE)).toMatchObject({
      kind: "plain",
      owner: SOLANA_PROGRAMS.systemProgram,
      space: 0,
      lamports: 500n,
    })
    cluster.addMint(MINT).setBalance(MINT, 9n)
    expect(cluster.balanceOf(MINT)).toBe(9n)
    expect(cluster.entryAt(MINT)?.kind).toBe("mint")
    cluster.setBalance(ALICE, 0n)
    expect(cluster.entryAt(ALICE)).toBeUndefined()
  })

  test("a mint and a token account of Token-2022 take the space their extensions need, rent-exempt by default", () => {
    const cluster = new FakeSolanaCluster()
      .addMint(MINT, { program: SOLANA_PROGRAMS.token2022Program, extensions: [{ extension: "tokenMetadata" }] })
      .addTokenAccount(ALICE, MINT, BOB)
    expect(cluster.entryAt(MINT)).toMatchObject({
      space: 170,
      lamports: cluster.rentFor(170),
      owner: SOLANA_PROGRAMS.token2022Program,
    })
    expect(cluster.entryAt(ALICE)).toMatchObject({ space: 165, owner: SOLANA_PROGRAMS.token2022Program })
  })

  test("an associated token account is put at its derived address, under its mint's program", () => {
    const cluster = new FakeSolanaCluster().addMint(MINT, { program: SOLANA_PROGRAMS.token2022Program })
    const address = cluster.addAssociatedTokenAccount(ALICE, MINT, { amount: 5n })
    expect(address).toBe(associatedTokenAddress(ALICE, MINT, SOLANA_PROGRAMS.token2022Program))
    expect(cluster.tokenBalanceOf(address)).toBe(5n)
    expect(cluster.tokenBalanceOf(BOB)).toBe(0n)
    expect(() => cluster.addAssociatedTokenAccount(ALICE, BOB)).toThrow("no mint")
  })

  test("a metadata account is put at the mint's metadata address, owned by Token Metadata", async () => {
    const cluster = new FakeSolanaCluster()
    const address = cluster.addMetadata({ mint: MINT, symbol: "ABC", tokenStandard: 0 })
    expect(address).toBe(metadataAddress(MINT))
    expect(cluster.entryAt(address)).toMatchObject({ owner: SOLANA_PROGRAMS.tokenMetadataProgram, space: 679 })
  })

  test("test keys give each index its own address, the one `testAddress` gives", () => {
    expect(testKeypair(5).address).toBe(testAddress(5))
    expect(testKeypair(5).address).not.toBe(testKeypair(6).address)
  })
})
