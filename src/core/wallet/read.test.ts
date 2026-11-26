import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { isToolError, type ErrorCode } from "../errors"
import {
  fakeRuntime,
  HARDHAT_KEY_0,
  HARDHAT_PHRASE,
  holdsKeyMaterial,
  makeStateDir,
  SOLANA_KEYPAIR_JSON,
  writeWallet,
} from "../signer/testing"
import { annotations, invoke, type ToolContext } from "../tool"
import { defineWalletRead, web3WalletRead } from "./read"

const HARDHAT_EVM = ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]
const HARDHAT_SOLANA = ["oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96", "AqynRZwvVqUPRwRJXvm6odUb3t93fDjnWe3p6BeuUFxD"]
const SOLANA_KEY_ADDRESS = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB"
const HARDHAT_PHRASE_WORDS = 12
const WORLD_READABLE_WALLET_MODE = 0o644

let stateDir: string
let ctx: ToolContext

beforeEach(() => {
  stateDir = makeStateDir()
  ctx = { cwd: process.cwd(), runtime: fakeRuntime(), stateDir }
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

async function read(args: unknown, context = ctx) {
  const result = await invoke(defineWalletRead(), args, context)
  expect(holdsKeyMaterial(JSON.stringify(result))).toBe(false)
  return result
}

async function refusal(args: unknown, code: ErrorCode = "invalid_argument", context = ctx): Promise<Error> {
  try {
    await read(args, context)
  } catch (error) {
    expect(isToolError(error) && error.code).toBe(code)
    expect(holdsKeyMaterial(error)).toBe(false)
    return error as Error
  }
  throw new Error("The call did not refuse")
}

describe("web3WalletRead list", () => {
  test("publishes read class annotations", () => {
    expect(annotations(web3WalletRead)).toEqual({
      title: "Read wallets",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("returns an empty list when no wallets are set up", async () => {
    expect(await read({ method: "list" })).toEqual({ wallets: [] })
  })

  test("lists phrases, EVM keys and Solana keypairs in label order", async () => {
    writeWallet(stateDir, "phrase", HARDHAT_PHRASE)
    writeWallet(stateDir, "sol", SOLANA_KEYPAIR_JSON)
    writeWallet(stateDir, "evm", HARDHAT_PHRASE)
    ctx.runtime = fakeRuntime({ WEB3_TOOLS_WALLET_EVM: HARDHAT_KEY_0 })
    expect(await read({ method: "list" })).toEqual({
      wallets: [
        { label: "evm", source: "variable", kind: "evm", evm: HARDHAT_EVM[0] },
        {
          label: "phrase",
          source: "file",
          kind: "phrase",
          words: HARDHAT_PHRASE_WORDS,
          evm: HARDHAT_EVM[0],
          solana: HARDHAT_SOLANA[0],
        },
        { label: "sol", source: "file", kind: "solana", solana: SOLANA_KEY_ADDRESS },
      ],
    })
  })

  test("keeps a forbidden file as a problem without addresses", async () => {
    writeWallet(stateDir, "loose", HARDHAT_PHRASE, WORLD_READABLE_WALLET_MODE)
    const result = await read({ method: "list" })
    expect(result.wallets).toEqual([
      { label: "loose", source: "file", problem: { code: "forbidden", message: expect.any(String) } },
    ])
  })

  test("keeps invalid and unreadable keys as problems", async () => {
    ctx.runtime = fakeRuntime({ WEB3_TOOLS_WALLET_BAD: "not a key", WEB3_TOOLS_WALLET_EMPTY: "" })
    const result = await read({ method: "list" })
    expect(result.wallets).toEqual([
      { label: "bad", source: "variable", problem: { code: "unauthenticated", message: expect.any(String) } },
      { label: "empty", source: "variable", problem: { code: "unauthenticated", message: expect.any(String) } },
    ])
  })
})

describe("web3WalletRead accounts", () => {
  test("returns a phrase's first two accounts on both families", async () => {
    writeWallet(stateDir, "main", HARDHAT_PHRASE)
    expect(await read({ method: "accounts", account: "main", from: 0, count: 2 })).toEqual({
      wallet: { label: "main", source: "file", kind: "phrase", words: HARDHAT_PHRASE_WORDS },
      accounts: [
        { index: 0, evm: HARDHAT_EVM[0], solana: HARDHAT_SOLANA[0] },
        { index: 1, evm: HARDHAT_EVM[1], solana: HARDHAT_SOLANA[1] },
      ],
    })
    expect((await read({ method: "accounts", from: 1, count: 1 })).accounts).toEqual([
      { index: 1, evm: HARDHAT_EVM[1], solana: HARDHAT_SOLANA[1] },
    ])
  })

  test("defaults to the only label and ten accounts from zero", async () => {
    writeWallet(stateDir, "main", HARDHAT_PHRASE)
    const result = await read({ method: "accounts" })
    expect(result.wallet).toEqual({ label: "main", source: "file", kind: "phrase", words: HARDHAT_PHRASE_WORDS })
    expect(result.accounts?.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.accounts?.[0]).toEqual({ index: 0, evm: HARDHAT_EVM[0], solana: HARDHAT_SOLANA[0] })
  })

  test("returns a lone key with a null index, ignoring the range", async () => {
    ctx.runtime = fakeRuntime({ WEB3_TOOLS_WALLET_EVM: HARDHAT_KEY_0 })
    expect(await read({ method: "accounts", from: 5, count: 3 })).toEqual({
      wallet: { label: "evm", source: "variable", kind: "evm" },
      accounts: [{ index: null, evm: HARDHAT_EVM[0] }],
    })
    writeWallet(stateDir, "sol", SOLANA_KEYPAIR_JSON)
    expect(await read({ method: "accounts", account: "sol" })).toEqual({
      wallet: { label: "sol", source: "file", kind: "solana" },
      accounts: [{ index: null, solana: SOLANA_KEY_ADDRESS }],
    })
  })

  test("explains how a person sets up a missing wallet", async () => {
    const error = await refusal({ method: "accounts" })
    expect(error.message).toContain("No wallet is set up")
    expect(error.message).toContain("a person")
    expect(error.message).toContain("web3-tools-cli wallet import")
    expect(error.message).toContain("web3-tools-cli wallet create")
    await refusal({ method: "accounts", account: "absent" }, "unauthenticated")
  })

  test("lists labels when several are set up", async () => {
    writeWallet(stateDir, "z", HARDHAT_PHRASE)
    writeWallet(stateDir, "a", HARDHAT_KEY_0)
    const error = await refusal({ method: "accounts" })
    expect(error.message).toContain("a, z")
    expect(error.message).toContain('"account"')
  })

  test("accepts the last index and the full range", async () => {
    writeWallet(stateDir, "main", HARDHAT_PHRASE)
    expect((await read({ method: "accounts", from: 100, count: 1 })).accounts?.[0].index).toBe(100)
    expect((await read({ method: "accounts", from: 0, count: 101 })).accounts).toHaveLength(101)
  })

  test("propagates a wallet refusal instead of returning a problem", async () => {
    writeWallet(stateDir, "loose", HARDHAT_PHRASE, WORLD_READABLE_WALLET_MODE)
    await refusal({ method: "accounts" }, "forbidden")
  })
})

describe("web3WalletRead arguments", () => {
  test.each(["account", "from", "count"])("refuses %s for list, naming it", async (key) => {
    const error = await refusal({ method: "list", [key]: key === "account" ? "main" : 1 })
    expect(error.message).toContain(key)
  })

  test.each([
    { method: "unknown" },
    { method: "list", unexpected: true },
    { method: "accounts", from: -1 },
    { method: "accounts", from: 101 },
    { method: "accounts", from: 0.5 },
    { method: "accounts", count: 0 },
    { method: "accounts", count: 102 },
    { method: "accounts", count: 1.5 },
    { method: "accounts", from: 100, count: 2 },
    { method: "accounts", from: 92 },
    { method: "accounts", account: "main#1" },
  ])("refuses invalid arguments %p", async (args) => {
    await refusal(args)
  })

  test.each([
    { cwd: process.cwd() },
    { cwd: process.cwd(), runtime: fakeRuntime() },
    { cwd: process.cwd(), stateDir: "/absolute" },
    { cwd: process.cwd(), runtime: fakeRuntime(), stateDir: "relative" },
  ])("requires a runtime and absolute state directory %p", async (context) => {
    await refusal({ method: "list" }, "internal_error", context)
  })
})
