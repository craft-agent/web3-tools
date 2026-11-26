import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { hexToBytes } from "@noble/curves/utils.js"
import { rmSync } from "node:fs"
import { isToolError } from "../errors"
import type { ErrorCode } from "../errors"
import { ownAddresses, resolveAccount } from "./accounts"
import { evmAddress, MAX_ACCOUNT_INDEX, solanaAddress } from "./derive"
import {
  fakeRuntime,
  HARDHAT_KEY_0,
  HARDHAT_PHRASE,
  holdsKeyMaterial,
  makeStateDir,
  SOLANA_KEYPAIR_JSON,
  writeWallet,
} from "./testing"

const HARDHAT_EVM_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const HARDHAT_EVM_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const HARDHAT_SOLANA_0 = "oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96"
const HARDHAT_SOLANA_1 = "AqynRZwvVqUPRwRJXvm6odUb3t93fDjnWe3p6BeuUFxD"
const SOLANA_KEY_ADDRESS = solanaAddress(new Uint8Array(32).fill(7))
const OTHER_EVM_SECRET_HEX = "11".repeat(32)
const OTHER_EVM_ADDRESS = evmAddress(hexToBytes(OTHER_EVM_SECRET_HEX))

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

describe("ownAddresses", () => {
  test("is empty when no wallet is set up", async () => {
    const own = await ownAddresses(fakeRuntime(), stateDir)
    expect(own.evm.size + own.solana.size).toBe(0)
    expect(own.unreadable).toEqual([])
  })

  test("holds accounts 0 to 100 of a phrase on both families, and each key's address", async () => {
    writeWallet(stateDir, "seed", HARDHAT_PHRASE)
    writeWallet(stateDir, "evm", `0x${OTHER_EVM_SECRET_HEX}`)
    writeWallet(stateDir, "sol", SOLANA_KEYPAIR_JSON)
    writeWallet(stateDir, "loose", HARDHAT_PHRASE, 0o644)
    const own = await ownAddresses(fakeRuntime(), stateDir)

    expect(own.unreadable).toEqual(["loose"])
    expect(own.evm.get(OTHER_EVM_ADDRESS.toLowerCase())).toEqual({ label: "evm", index: null })
    expect(own.evm.get(HARDHAT_EVM_0.toLowerCase())).toEqual({ label: "seed", index: 0 })
    expect(own.evm.get(HARDHAT_EVM_1.toLowerCase())).toEqual({ label: "seed", index: 1 })
    expect(own.solana.get(HARDHAT_SOLANA_0)).toEqual({ label: "seed", index: 0 })
    expect(own.solana.get(HARDHAT_SOLANA_1)).toEqual({ label: "seed", index: 1 })
    expect(own.solana.get(SOLANA_KEY_ADDRESS)).toEqual({ label: "sol", index: null })
    expect([...own.evm.values()].filter((owner) => owner.label === "seed")).toHaveLength(MAX_ACCOUNT_INDEX + 1)
    expect([...own.solana.values()].filter((owner) => owner.label === "seed")).toHaveLength(MAX_ACCOUNT_INDEX + 1)
    expect([...own.evm.values()].some((owner) => owner.index === MAX_ACCOUNT_INDEX)).toBe(true)
    expect([...own.solana.values()].some((owner) => owner.index === MAX_ACCOUNT_INDEX)).toBe(true)
    expect(own.evm.size).toBe(MAX_ACCOUNT_INDEX + 2)
    expect(own.solana.size).toBe(MAX_ACCOUNT_INDEX + 2)
    for (const address of own.evm.keys()) expect(address).toBe(address.toLowerCase())
    expect(holdsKeyMaterial({ evm: [...own.evm], solana: [...own.solana], unreadable: own.unreadable })).toBe(false)
  })

  test("reads a label's variable as well as files", async () => {
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_ENV: HARDHAT_PHRASE, WEB3_TOOLS_WALLET_BAD: "hunter2" })
    const own = await ownAddresses(runtime, stateDir)
    expect(own.evm.get(HARDHAT_EVM_0.toLowerCase())).toEqual({ label: "env", index: 0 })
    expect(own.unreadable).toEqual(["bad"])
  })

  test("lists every label whose key cannot be read, and none that can", async () => {
    writeWallet(stateDir, "aaa", "not a key")
    writeWallet(stateDir, "bbb", HARDHAT_KEY_0)
    writeWallet(stateDir, "ccc", HARDHAT_KEY_0, 0o666)
    const own = await ownAddresses(fakeRuntime(), stateDir)
    expect(own.unreadable).toEqual(["aaa", "ccc"])
    expect(own.evm.get(HARDHAT_EVM_0.toLowerCase())).toEqual({ label: "bbb", index: null })
  })

  test("keeps the first label, in label order, for an address two wallets share", async () => {
    writeWallet(stateDir, "zeta", HARDHAT_PHRASE)
    writeWallet(stateDir, "alpha", HARDHAT_KEY_0)
    const own = await ownAddresses(fakeRuntime(), stateDir)
    expect(own.evm.get(HARDHAT_EVM_0.toLowerCase())).toEqual({ label: "alpha", index: null })
  })
})

describe("resolveAccount", () => {
  test("takes the only label when none is given, and account 0 of a phrase", async () => {
    writeWallet(stateDir, "main", HARDHAT_PHRASE)
    expect(await resolveAccount(undefined, "evm", fakeRuntime(), stateDir)).toEqual({
      label: "main",
      index: 0,
      address: HARDHAT_EVM_0,
    })
    expect(await resolveAccount("main", "solana", fakeRuntime(), stateDir)).toEqual({
      label: "main",
      index: 0,
      address: HARDHAT_SOLANA_0,
    })
  })

  test("takes the account a phrase's index names", async () => {
    writeWallet(stateDir, "main", HARDHAT_PHRASE)
    expect(await resolveAccount("main#1", "evm", fakeRuntime(), stateDir)).toEqual({
      label: "main",
      index: 1,
      address: HARDHAT_EVM_1,
    })
    expect((await resolveAccount("main#1", "solana", fakeRuntime(), stateDir)).address).toBe(HARDHAT_SOLANA_1)
  })

  test("takes a lone key with no index, and accepts #0 for it", async () => {
    writeWallet(stateDir, "evm", HARDHAT_KEY_0)
    const expected = { label: "evm", index: null, address: HARDHAT_EVM_0 }
    expect(await resolveAccount("evm", "evm", fakeRuntime(), stateDir)).toEqual(expected)
    expect(await resolveAccount("evm#0", "evm", fakeRuntime(), stateDir)).toEqual(expected)
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_SOL: SOLANA_KEYPAIR_JSON })
    expect(await resolveAccount("sol", "solana", runtime, stateDir)).toEqual({
      label: "sol",
      index: null,
      address: SOLANA_KEY_ADDRESS,
    })
  })

  test("refuses any other index on a lone key", async () => {
    writeWallet(stateDir, "evm", HARDHAT_KEY_0)
    const error = await expectRefusal("invalid_argument", () => resolveAccount("evm#1", "evm", fakeRuntime(), stateDir))
    expect(error.message).toBe('Wallet "evm" holds a single key and has no account #1; use "evm".')
  })

  test("refuses a key of the other family", async () => {
    writeWallet(stateDir, "evm", HARDHAT_KEY_0)
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_SOL: SOLANA_KEYPAIR_JSON })
    const onSolana = await expectRefusal("invalid_argument", () => resolveAccount("evm", "solana", runtime, stateDir))
    expect(onSolana.message).toBe('Wallet "evm" holds an EVM key, which cannot act on Solana.')
    const onEvm = await expectRefusal("invalid_argument", () => resolveAccount("sol", "evm", runtime, stateDir))
    expect(onEvm.message).toBe('Wallet "sol" holds a Solana key, which cannot act on EVM chains.')
  })

  test("lists the labels when several are set up and none is named", async () => {
    writeWallet(stateDir, "beta", HARDHAT_PHRASE)
    writeWallet(stateDir, "alpha", HARDHAT_KEY_0)
    const error = await expectRefusal("invalid_argument", () =>
      resolveAccount(undefined, "evm", fakeRuntime(), stateDir),
    )
    expect(error.message).toContain("alpha, beta")
    expect((await resolveAccount("beta", "evm", fakeRuntime(), stateDir)).label).toBe("beta")
  })

  test("says how to set a wallet up when there is none", async () => {
    const error = await expectRefusal("invalid_argument", () =>
      resolveAccount(undefined, "evm", fakeRuntime(), stateDir),
    )
    expect(error.message).toContain("web3-tools-cli wallet import")
  })

  test("passes the refusals of a bad account, a missing key and an unreadable one through", async () => {
    writeWallet(stateDir, "loose", HARDHAT_KEY_0, 0o644)
    await expectRefusal("invalid_argument", () => resolveAccount("Main", "evm", fakeRuntime(), stateDir))
    await expectRefusal("invalid_argument", () => resolveAccount("main#101", "evm", fakeRuntime(), stateDir))
    await expectRefusal("unauthenticated", () => resolveAccount("absent", "evm", fakeRuntime(), stateDir))
    await expectRefusal("forbidden", () => resolveAccount("loose", "evm", fakeRuntime(), stateDir))
  })

  test("carries no key material in a result", async () => {
    writeWallet(stateDir, "main", HARDHAT_PHRASE)
    writeWallet(stateDir, "evm", HARDHAT_KEY_0)
    for (const account of ["main", "main#1", "evm"]) {
      expect(holdsKeyMaterial(await resolveAccount(account, "evm", fakeRuntime(), stateDir))).toBe(false)
    }
  })
})
