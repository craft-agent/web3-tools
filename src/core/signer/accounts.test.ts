import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { rmSync } from "node:fs"
import { isToolError } from "../errors"
import type { ErrorCode } from "../errors"
import * as derive from "./derive"
import { MAX_ACCOUNT_INDEX, solanaAddress } from "./derive"
import { parseAccount, walletAccounts } from "./accounts"
import {
  fakeRuntime,
  HARDHAT_KEY_0,
  HARDHAT_PHRASE,
  holdsKeyMaterial,
  makeStateDir,
  SOLANA_KEYPAIR_BASE58,
  SOLANA_KEYPAIR_JSON,
  writeWallet,
} from "./testing"

const HARDHAT_EVM = ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]
const HARDHAT_SOLANA = ["oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96", "AqynRZwvVqUPRwRJXvm6odUb3t93fDjnWe3p6BeuUFxD"]
const SOLANA_KEY_ADDRESS = solanaAddress(new Uint8Array(32).fill(7))

let stateDir: string

beforeEach(() => {
  stateDir = makeStateDir()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

async function failure(work: () => unknown): Promise<Error> {
  try {
    await work()
  } catch (error) {
    return error as Error
  }
  throw new Error("the call did not refuse")
}

async function expectRefusal(code: ErrorCode, work: () => unknown): Promise<Error> {
  const error = await failure(work)
  expect(isToolError(error) && error.code).toBe(code)
  expect(holdsKeyMaterial(error)).toBe(false)
  return error
}

describe("walletAccounts: a seed phrase", () => {
  beforeEach(() => {
    writeWallet(stateDir, "main", HARDHAT_PHRASE)
  })

  test("gives account 0 on both families by default", async () => {
    const result = await walletAccounts("main", fakeRuntime(), stateDir)
    expect(result).toEqual({
      label: "main",
      source: "file",
      kind: "phrase",
      words: 12,
      accounts: [{ index: 0, evm: HARDHAT_EVM[0], solana: HARDHAT_SOLANA[0] }],
    })
    expect(holdsKeyMaterial(result)).toBe(false)
  })

  test("gives `count` accounts from `from`", async () => {
    const { accounts } = await walletAccounts("main", fakeRuntime(), stateDir, { from: 1, count: 2 })
    expect(accounts.map((account) => account.index)).toEqual([1, 2])
    expect(accounts[0]).toEqual({ index: 1, evm: HARDHAT_EVM[1], solana: HARDHAT_SOLANA[1] })
  })

  test("reaches account 100 and no further", async () => {
    const last = await walletAccounts("main", fakeRuntime(), stateDir, { from: MAX_ACCOUNT_INDEX, count: 1 })
    expect(last.accounts.map((account) => account.index)).toEqual([MAX_ACCOUNT_INDEX])
    const all = await walletAccounts("main", fakeRuntime(), stateDir, { from: 0, count: MAX_ACCOUNT_INDEX + 1 })
    expect(all.accounts).toHaveLength(MAX_ACCOUNT_INDEX + 1)
    expect(new Set(all.accounts.map((account) => account.evm)).size).toBe(MAX_ACCOUNT_INDEX + 1)
    expect(all.accounts[MAX_ACCOUNT_INDEX]).toEqual(last.accounts[0])
  })

  test("refuses a range that is not whole, empty, negative or past account 100", async () => {
    const ranges = [
      { from: -1, count: 1 },
      { from: 0, count: 0 },
      { from: 0, count: -1 },
      { from: 0.5, count: 1 },
      { from: 0, count: 1.5 },
      { from: 0, count: MAX_ACCOUNT_INDEX + 2 },
      { from: MAX_ACCOUNT_INDEX, count: 2 },
      { from: MAX_ACCOUNT_INDEX + 1, count: 1 },
      { from: Number.NaN, count: 1 },
    ]
    for (const range of ranges) {
      const error = await expectRefusal("invalid_argument", () =>
        walletAccounts("main", fakeRuntime(), stateDir, range),
      )
      expect(error.message).toContain(`#${MAX_ACCOUNT_INDEX}`)
    }
  })

  test("checks the range before it reads any key", async () => {
    await expectRefusal("invalid_argument", () =>
      walletAccounts("absent", fakeRuntime(), stateDir, { from: 0, count: 0 }),
    )
  })

  test("reports where the key came from", async () => {
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: HARDHAT_PHRASE })
    expect((await walletAccounts("main", runtime, stateDir)).source).toBe("variable")
  })

  test("replaces a failure that is not a refusal with a fixed message and no cause", async () => {
    const spy = spyOn(derive, "phraseSeed").mockImplementation(() => {
      throw new Error(HARDHAT_PHRASE)
    })
    try {
      const error = await expectRefusal("internal_error", () => walletAccounts("main", fakeRuntime(), stateDir))
      expect(error.message).toBe('The signer failed while deriving the accounts of wallet "main".')
      expect(error.cause).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })
})

describe("walletAccounts: a lone key", () => {
  test("an EVM key gives its one address, with no index", async () => {
    writeWallet(stateDir, "evm", HARDHAT_KEY_0)
    const result = await walletAccounts("evm", fakeRuntime(), stateDir)
    expect(result).toEqual({
      label: "evm",
      source: "file",
      kind: "evm",
      accounts: [{ index: null, evm: HARDHAT_EVM[0] }],
    })
    expect(holdsKeyMaterial(result)).toBe(false)
  })

  test.each([
    ["base58", SOLANA_KEYPAIR_BASE58],
    ["JSON", SOLANA_KEYPAIR_JSON],
  ])("a Solana keypair as %s gives the address of its public half", async (_form, text) => {
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_SOL: text })
    const result = await walletAccounts("sol", runtime, stateDir)
    expect(result).toEqual({
      label: "sol",
      source: "variable",
      kind: "solana",
      accounts: [{ index: null, solana: SOLANA_KEY_ADDRESS }],
    })
    expect(holdsKeyMaterial(result)).toBe(false)
  })

  test("ignores a range, which only a seed phrase has accounts for", async () => {
    writeWallet(stateDir, "evm", HARDHAT_KEY_0)
    const { accounts } = await walletAccounts("evm", fakeRuntime(), stateDir, { from: 5, count: 3 })
    expect(accounts).toEqual([{ index: null, evm: HARDHAT_EVM[0] }])
  })

  test("passes a refusal of the key through", async () => {
    await expectRefusal("unauthenticated", () => walletAccounts("absent", fakeRuntime(), stateDir))
    writeWallet(stateDir, "loose", HARDHAT_KEY_0, 0o644)
    await expectRefusal("forbidden", () => walletAccounts("loose", fakeRuntime(), stateDir))
  })
})

describe("parseAccount", () => {
  test("takes a label alone, or with an index from 0 to 100", () => {
    expect(parseAccount("main")).toEqual({ label: "main", index: null })
    expect(parseAccount("main#0")).toEqual({ label: "main", index: 0 })
    expect(parseAccount("main#3")).toEqual({ label: "main", index: 3 })
    expect(parseAccount("a_1#100")).toEqual({ label: "a_1", index: 100 })
  })

  test.each([
    "main#",
    "main#-1",
    "main#01",
    "main#00",
    "main#101",
    "main#1.5",
    "main#x",
    "main#1#2",
    "main# 1",
    "main#１",
  ])("refuses the index of %p, stating the rule", (text) => {
    expect(() => parseAccount(text)).toThrow("whole number from 0 to 100 without leading zeros")
  })

  test.each(["", "#1", "Main#1", "-x#1", "main #1"])("refuses the label of %p", (text) => {
    expect(() => parseAccount(text)).toThrow("Invalid label")
  })

  test("throws invalid_argument", () => {
    expect(() => parseAccount("main#101")).toThrow(expect.objectContaining({ code: "invalid_argument" }))
  })
})
