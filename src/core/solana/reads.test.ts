import { describe, expect, test } from "bun:test"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { toolError } from "../rpc/client.fixtures"
import { accountOf, balanceOf, classifyRecipient, rawAccountOf, rentExemptMinimum } from "./reads"
import { accountAnswer, nodeClient, PYUSD_ACCOUNT } from "./reads.fixtures"
import { testAddress } from "./testing"
import { FakeSolanaCluster } from "./testing.cluster"

const ALICE = testAddress(1)
const BOB = testAddress(2)
const MINT = testAddress(3)
const OTHER_PROGRAM = testAddress(4)

describe("accountOf", () => {
  test("reads a wallet, a mint and a token account parsed, as the node shows them", async () => {
    const cluster = new FakeSolanaCluster()
      .setBalance(ALICE, 5_000_000n)
      .addMint(MINT, { decimals: 9, supply: 42n })
      .addTokenAccount(BOB, MINT, ALICE, { amount: 7n })
    const client = cluster.client()
    expect(await accountOf(client, ALICE)).toEqual({
      lamports: 5_000_000n,
      owner: SOLANA_PROGRAMS.systemProgram,
      executable: false,
      space: 0,
      data: new Uint8Array(),
    })
    expect(await accountOf(client, MINT)).toMatchObject({
      owner: SOLANA_PROGRAMS.tokenProgram,
      space: 82,
      parsed: { program: "spl-token", type: "mint", info: { decimals: 9, supply: "42" } },
    })
    expect(await accountOf(client, BOB)).toMatchObject({
      space: 165,
      parsed: { type: "account", info: { mint: MINT, owner: ALICE, tokenAmount: { amount: "7" } } },
    })
    expect(cluster.requestsOf("getAccountInfo")[0]).toEqual([
      ALICE,
      { commitment: "confirmed", encoding: "jsonParsed" },
    ])
  })

  test("is null for an address with no account", async () => {
    expect(await accountOf(new FakeSolanaCluster().client(), ALICE)).toBeNull()
    expect(await rawAccountOf(new FakeSolanaCluster().client(), ALICE)).toBeNull()
  })

  test("reads what a real node answered for a Token-2022 mint", async () => {
    const { client } = nodeClient({ getAccountInfo: accountAnswer(PYUSD_ACCOUNT) })
    const account = await accountOf(client, MINT)
    expect(account).toMatchObject({ owner: SOLANA_PROGRAMS.token2022Program, space: 866, lamports: 2_078_412_094n })
    expect(account?.parsed?.program).toBe("spl-token-2022")
    expect(account?.data).toBeUndefined()
  })

  test("reads raw bytes with base64: the metadata account's 679 bytes", async () => {
    const cluster = new FakeSolanaCluster()
    const address = cluster.addMetadata({ mint: MINT, symbol: "ABC", tokenStandard: 0 })
    const account = await rawAccountOf(cluster.client(), address)
    expect(account).toMatchObject({ owner: SOLANA_PROGRAMS.tokenMetadataProgram, space: 679 })
    expect(account?.data?.length).toBe(679)
    expect(account?.data?.[0]).toBe(4)
    expect(cluster.requestsOf("getAccountInfo")[0]).toEqual([address, { commitment: "confirmed", encoding: "base64" }])
  })

  test("an answer that is not an account is upstream_error naming the cluster", async () => {
    const bad: unknown[] = [
      5,
      { value: 5 },
      { value: { lamports: -1, owner: ALICE, executable: false, data: ["", "base64"] } },
      { value: { lamports: 1, owner: ALICE, executable: false, space: 0, data: ["!!", "base64"] } },
      { value: { lamports: 1, owner: ALICE, executable: false, space: 0, data: ["", "base58"] } },
      { value: { lamports: 1, owner: ALICE, executable: false, data: { program: "x", parsed: { type: "t" } } } },
      { value: { lamports: 1, owner: ALICE, executable: "no", space: 0, data: ["", "base64"] } },
    ]
    for (const result of bad) {
      const error = await toolError(accountOf(nodeClient({ getAccountInfo: { result } }).client, ALICE))
      expect(error.code).toBe("upstream_error")
      expect(error.message).toContain("Solana")
    }
  })

  test("raw bytes asked for but parsed data answered is upstream_error", async () => {
    const { client } = nodeClient({ getAccountInfo: accountAnswer(PYUSD_ACCOUNT) })
    expect((await toolError(rawAccountOf(client, MINT))).code).toBe("upstream_error")
  })
})

describe("classifyRecipient", () => {
  const cluster = new FakeSolanaCluster()
    .setBalance(ALICE, 1_000_000n)
    .setAccount(OTHER_PROGRAM, { owner: SOLANA_PROGRAMS.systemProgram, space: 80 })
    .addMint(MINT)
    .addTokenAccount(testAddress(5), MINT, ALICE)
    .setAccount(testAddress(6), { owner: SOLANA_PROGRAMS.tokenMetadataProgram, executable: true, space: 36 })
    .setAccount(testAddress(7), { owner: SOLANA_PROGRAMS.systemProgram, space: 10 })
    .setAccount(testAddress(8), { owner: testAddress(9), space: 0 })
    .setAccount(testAddress(10), { owner: SOLANA_PROGRAMS.tokenProgram, space: 355 })
  const kindOf = async (address: string) => classifyRecipient(await accountOf(cluster.client(), address))

  test("tells a new address and a wallet apart from the rest", async () => {
    expect(await kindOf(BOB)).toBe("new")
    expect(await kindOf(ALICE)).toBe("wallet")
  })

  test("names each kind it refuses", async () => {
    expect(await kindOf(testAddress(6))).toBe("program")
    expect(await kindOf(testAddress(5))).toBe("token_account")
    expect(await kindOf(MINT)).toBe("mint")
    expect(await kindOf(OTHER_PROGRAM)).toBe("nonce")
  })

  test("any other owner, other System data, or unparsed token program data is other", async () => {
    expect(await kindOf(testAddress(7))).toBe("other")
    expect(await kindOf(testAddress(8))).toBe("other")
    expect(await kindOf(testAddress(10))).toBe("other")
  })

  test("an executable account is a program whoever owns it, and a nonce needs the System program", () => {
    const base = { lamports: 1n, executable: false, space: 0 }
    expect(classifyRecipient({ ...base, owner: SOLANA_PROGRAMS.systemProgram, executable: true })).toBe("program")
    expect(classifyRecipient({ ...base, owner: SOLANA_PROGRAMS.tokenProgram, space: 80 })).toBe("other")
  })
})

describe("balanceOf and rentExemptMinimum", () => {
  test("read lamports, 0 for an address with no account, and the rent the cluster asks now", async () => {
    const cluster = new FakeSolanaCluster().setBalance(ALICE, 123n)
    const client = cluster.client()
    expect(await balanceOf(client, ALICE)).toBe(123n)
    expect(await balanceOf(client, BOB)).toBe(0n)
    expect(await rentExemptMinimum(client, 0)).toBe(650_240n)
    expect(await rentExemptMinimum(client, 165)).toBe(1_488_440n)
    cluster.lamportsPerByte = 1000n
    expect(await rentExemptMinimum(client, 0)).toBe(128_000n)
    expect(cluster.requestsOf("getBalance")[0]).toEqual([ALICE, { commitment: "confirmed" }])
    expect(cluster.requestsOf("getMinimumBalanceForRentExemption")[0]).toEqual([0, { commitment: "confirmed" }])
  })

  test("an answer that is not a count of lamports is upstream_error", async () => {
    for (const result of ["5", -1, 1.5, null, { value: "5" }]) {
      const { client } = nodeClient({ getBalance: { result }, getMinimumBalanceForRentExemption: { result } })
      expect((await toolError(balanceOf(client, ALICE))).code).toBe("upstream_error")
      expect((await toolError(rentExemptMinimum(client, 0))).message).toContain("Solana")
    }
  })
})
