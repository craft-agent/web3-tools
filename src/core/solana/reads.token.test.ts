import { describe, expect, test } from "bun:test"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { toolError } from "../rpc/client.fixtures"
import { accountAnswer, nodeClient, PYUSD_ACCOUNT } from "./reads.fixtures"
import { mintFacts, tokenAccountFacts } from "./reads.token"
import { testAddress } from "./testing"
import { FakeSolanaCluster } from "./testing.cluster"

const ALICE = testAddress(1)
const BOB = testAddress(2)
const MINT = testAddress(3)
const ACCOUNT = testAddress(4)

describe("mintFacts", () => {
  test("reads the program, decimals, supply, freeze authority and extensions of a mint", async () => {
    const cluster = new FakeSolanaCluster().addMint(MINT, {
      decimals: 9,
      supply: 2n ** 64n - 1n,
      freezeAuthority: ALICE,
      program: SOLANA_PROGRAMS.token2022Program,
      extensions: [
        { extension: "nonTransferable" },
        { extension: "pausableConfig", state: { authority: null, paused: true } },
      ],
    })
    expect(await mintFacts(cluster.client(), MINT)).toEqual({
      program: SOLANA_PROGRAMS.token2022Program,
      decimals: 9,
      supply: 2n ** 64n - 1n,
      freezeAuthority: ALICE,
      extensions: [
        { name: "nonTransferable", state: {} },
        { name: "pausableConfig", state: { authority: null, paused: true } },
      ],
    })
  })

  test("a mint of the Token program with no authority and no extension", async () => {
    const facts = await mintFacts(new FakeSolanaCluster().addMint(MINT).client(), MINT)
    expect(facts).toEqual({
      program: SOLANA_PROGRAMS.tokenProgram,
      decimals: 6,
      supply: 0n,
      freezeAuthority: null,
      extensions: [],
    })
  })

  test("reads what a real node answered for a Token-2022 mint with extensions", async () => {
    const { client } = nodeClient({ getAccountInfo: accountAnswer(PYUSD_ACCOUNT) })
    const facts = await mintFacts(client, MINT)
    expect(facts.supply).toBe(738_568_181_056_273n)
    expect(facts.extensions.map((extension) => extension.name)).toEqual([
      "mintCloseAuthority",
      "permanentDelegate",
      "transferFeeConfig",
      "confidentialTransferMint",
      "transferHook",
      "metadataPointer",
      "tokenMetadata",
    ])
    expect(facts.extensions[1].state.delegate).toBe("2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk")
  })

  test("an address that is no token mint is invalid_argument saying so: no account, a wallet, a token account, a program's account", async () => {
    const cluster = new FakeSolanaCluster()
      .setBalance(ALICE, 1_000_000n)
      .addMint(MINT)
      .addTokenAccount(ACCOUNT, MINT, ALICE)
      .setAccount(BOB, { owner: SOLANA_PROGRAMS.tokenMetadataProgram, space: 10 })
    for (const address of [testAddress(9), ALICE, ACCOUNT, BOB]) {
      const error = await toolError(mintFacts(cluster.client(), address))
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("is not a token mint")
    }
  })

  test("a token program's account the node did not parse, or with another shape, is upstream_error", async () => {
    const owner = SOLANA_PROGRAMS.tokenProgram
    const unparsed = { lamports: 1, owner, executable: false, space: 82, data: ["", "base64"] }
    const parsed = (info: unknown) => ({
      ...unparsed,
      data: { program: "spl-token", parsed: { type: "mint", info }, space: 82 },
    })
    const cases = [
      unparsed,
      parsed({ decimals: 6, supply: "1", isInitialized: true, freezeAuthority: 5 }),
      parsed({ decimals: 6, supply: "-1", isInitialized: true }),
      parsed({ decimals: 300, supply: "1", isInitialized: true }),
      parsed(null),
    ]
    for (const value of cases) {
      const error = await toolError(mintFacts(nodeClient({ getAccountInfo: accountAnswer(value) }).client, MINT))
      expect(error.code).toBe("upstream_error")
      expect(error.message).toContain("Solana")
    }
  })
})

describe("tokenAccountFacts", () => {
  test("reads the mint, owner, amount, delegate and state of a token account", async () => {
    const cluster = new FakeSolanaCluster().addMint(MINT, { decimals: 2 }).addTokenAccount(ACCOUNT, MINT, ALICE, {
      amount: 1_234n,
      delegate: BOB,
      delegatedAmount: 50n,
      state: "frozen",
      program: SOLANA_PROGRAMS.token2022Program,
      extensions: [{ extension: "memoTransfer", state: { requireIncomingTransferMemos: true } }],
    })
    expect(await tokenAccountFacts(cluster.client(), ACCOUNT)).toEqual({
      mint: MINT,
      owner: ALICE,
      amount: 1_234n,
      delegate: BOB,
      delegatedAmount: 50n,
      state: "frozen",
      extensions: [{ name: "memoTransfer", state: { requireIncomingTransferMemos: true } }],
    })
  })

  test("an account without a delegate has none and a delegated amount of 0", async () => {
    const cluster = new FakeSolanaCluster().addMint(MINT).addTokenAccount(ACCOUNT, MINT, ALICE)
    expect(await tokenAccountFacts(cluster.client(), ACCOUNT)).toMatchObject({
      amount: 0n,
      delegate: null,
      delegatedAmount: 0n,
      state: "initialized",
      extensions: [],
    })
  })

  test("is null when there is no account, and refuses an account that is not an initialized token account", async () => {
    const cluster = new FakeSolanaCluster().setBalance(ALICE, 1_000_000n).addMint(MINT)
    expect(await tokenAccountFacts(cluster.client(), BOB)).toBeNull()
    for (const address of [ALICE, MINT]) {
      const error = await toolError(tokenAccountFacts(cluster.client(), address))
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("is not an initialized token account")
    }
    const uninitialized = {
      lamports: 1,
      owner: SOLANA_PROGRAMS.tokenProgram,
      executable: false,
      space: 165,
      data: {
        program: "spl-token",
        parsed: {
          type: "account",
          info: { mint: MINT, owner: ALICE, tokenAmount: { amount: "0" }, state: "uninitialized" },
        },
      },
    }
    const { client } = nodeClient({ getAccountInfo: accountAnswer(uninitialized) })
    expect((await toolError(tokenAccountFacts(client, ACCOUNT))).code).toBe("invalid_argument")
  })

  test("an account of another shape is upstream_error", async () => {
    const value = {
      lamports: 1,
      owner: SOLANA_PROGRAMS.tokenProgram,
      executable: false,
      space: 165,
      data: {
        program: "spl-token",
        parsed: { type: "account", info: { mint: MINT, owner: ALICE, state: "initialized" } },
      },
    }
    const { client } = nodeClient({ getAccountInfo: accountAnswer(value) })
    expect((await toolError(tokenAccountFacts(client, ACCOUNT))).code).toBe("upstream_error")
  })
})
