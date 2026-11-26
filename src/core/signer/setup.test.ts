import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { join } from "node:path"
import * as bip39 from "@scure/bip39"
import { validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { isToolError } from "../errors"
import type { ErrorCode } from "../errors"
import { solanaAddress } from "./derive"
import { walletAccounts } from "./accounts"
import { walletPaths } from "./labels"
import { createWallet, importWallet, refuseWhileVariableSet } from "./setup"
import type { SetupResult } from "./setup"
import {
  ABANDON_PHRASE,
  fakeRuntime,
  HARDHAT_KEY_0,
  HARDHAT_PHRASE,
  holdsKeyMaterial,
  makeStateDir,
  SOLANA_KEYPAIR_BASE58,
  SOLANA_KEYPAIR_JSON,
  writeWallet,
} from "./testing"

const HARDHAT_EVM_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const HARDHAT_SOLANA_0 = "oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96"
const SOLANA_KEY_ADDRESS = solanaAddress(new Uint8Array(32).fill(7))

let stateDir: string

beforeEach(() => {
  stateDir = makeStateDir()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

async function failure(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work()
  } catch (error) {
    return error as Error
  }
  throw new Error("the call did not refuse")
}

async function expectRefusal(code: ErrorCode, work: () => Promise<unknown>): Promise<Error> {
  const error = await failure(work)
  expect(isToolError(error) && error.code).toBe(code)
  expect(holdsKeyMaterial(error)).toBe(false)
  expect(error.cause).toBeUndefined()
  return error
}

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

/** Makes every write of a wallet file write `replacement` instead of its text. */
async function writeInstead(replacement: string) {
  const probe = await fsPromises.open(join(stateDir, "probe"), "w")
  const prototype = Object.getPrototypeOf(probe)
  await probe.close()
  const original = prototype.writeFile
  return spyOn(prototype, "writeFile").mockImplementation(function (this: unknown) {
    return original.call(this, replacement)
  })
}

describe("importWallet: every form of key", () => {
  test.each<[string, string, Omit<SetupResult, "label" | "file">]>([
    ["a seed phrase", HARDHAT_PHRASE, { kind: "phrase", words: 12, evm: HARDHAT_EVM_0, solana: HARDHAT_SOLANA_0 }],
    ["an EVM private key", HARDHAT_KEY_0, { kind: "evm", evm: HARDHAT_EVM_0 }],
    ["a Solana keypair in base58", SOLANA_KEYPAIR_BASE58, { kind: "solana", solana: SOLANA_KEY_ADDRESS }],
    ["a Solana keypair as JSON", SOLANA_KEYPAIR_JSON, { kind: "solana", solana: SOLANA_KEY_ADDRESS }],
  ])("%s is written with a newline, mode 600, and gives account 0", async (_name, text, expected) => {
    const result = await importWallet("main", text, fakeRuntime(), stateDir)
    const { file } = walletPaths(stateDir, "main")
    expect(result).toEqual({ label: "main", file, ...expected })
    expect(readFileSync(file, "utf8")).toBe(`${text}\n`)
    expect(mode(file)).toBe(0o600)
    expect(readdirSync(walletPaths(stateDir, "main").dir)).toEqual(["wallet"])
    expect(holdsKeyMaterial(result)).toBe(false)
  })

  test("trims the text around the key", async () => {
    const result = await importWallet("main", `\n  ${HARDHAT_KEY_0}  \r\n`, fakeRuntime(), stateDir)
    expect(readFileSync(result.file, "utf8")).toBe(`${HARDHAT_KEY_0}\n`)
  })

  test("what it wrote is what the signer reads", async () => {
    await importWallet("main", HARDHAT_PHRASE, fakeRuntime(), stateDir)
    const accounts = await walletAccounts("main", fakeRuntime(), stateDir)
    expect(accounts.accounts[0]).toEqual({ index: 0, evm: HARDHAT_EVM_0, solana: HARDHAT_SOLANA_0 })
  })
})

describe("importWallet: refusals write nothing", () => {
  test.each([
    ["empty", ""],
    ["not a key", "hunter2 is my password"],
    ["a phrase with a bad checksum", "abandon ".repeat(12).trim()],
    ["a short hex key", HARDHAT_KEY_0.slice(0, 40)],
  ])("a key that is %s is refused as unauthenticated, and no directory or file is left", async (_name, text) => {
    const error = await expectRefusal("unauthenticated", () => importWallet("main", text, fakeRuntime(), stateDir))
    expect(error.message).not.toContain("hunter2")
    expect(readdirSync(stateDir)).toEqual([])
  })

  test("a bad label is refused", async () => {
    await expectRefusal("invalid_argument", () => importWallet("Main!", HARDHAT_KEY_0, fakeRuntime(), stateDir))
    expect(readdirSync(stateDir)).toEqual([])
  })

  test("a label whose variable is set, even empty, is refused and nothing is written", async () => {
    for (const value of ["", HARDHAT_KEY_0]) {
      const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: value })
      const error = await expectRefusal("invalid_argument", () =>
        importWallet("main", HARDHAT_KEY_0, runtime, stateDir),
      )
      expect(error.message).toBe(
        'WEB3_TOOLS_WALLET_MAIN is set, so wallet "main" is read from it and a file would never be read; unset it to keep the key in a file.',
      )
    }
    expect(readdirSync(stateDir)).toEqual([])
  })

  test("another label's variable does not matter", async () => {
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_OTHER: HARDHAT_KEY_0 })
    expect((await importWallet("main", HARDHAT_KEY_0, runtime, stateDir)).kind).toBe("evm")
  })

  test("a label that has a wallet is refused and its file is untouched", async () => {
    const file = writeWallet(stateDir, "main", HARDHAT_PHRASE)
    const error = await expectRefusal("invalid_argument", () =>
      importWallet("main", ABANDON_PHRASE, fakeRuntime(), stateDir),
    )
    expect(error.message).toBe(`Wallet "main" already exists at ${file}; a wallet is never overwritten.`)
    expect(readFileSync(file, "utf8")).toBe(HARDHAT_PHRASE)
    expect(readdirSync(walletPaths(stateDir, "main").dir)).toEqual(["wallet"])
  })
})

describe("importWallet: the read-back", () => {
  test("a file that gives another account is reported as possibly written, with the path, and never as success", async () => {
    const write = await writeInstead(ABANDON_PHRASE)
    try {
      const error = await expectRefusal("internal_error", () =>
        importWallet("main", HARDHAT_PHRASE, fakeRuntime(), stateDir),
      )
      const { file } = walletPaths(stateDir, "main")
      expect(error.message).toBe(
        `Wallet "main" may have been written to ${file}, but it could not be read back as written. Do not fund it: check the file, and delete it by hand if it is wrong.`,
      )
      expect(write).toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })

  test("a file that cannot be read back is reported the same way", async () => {
    const write = await writeInstead("not a key")
    try {
      const error = await expectRefusal("internal_error", () =>
        importWallet("main", HARDHAT_KEY_0, fakeRuntime(), stateDir),
      )
      expect(error.message).toContain("Do not fund it")
    } finally {
      write.mockRestore()
    }
  })
})

describe("createWallet", () => {
  test.each([12, 24] as const)("makes a phrase of %d valid words in a file with mode 600", async (words) => {
    const result = await createWallet("fresh", words, fakeRuntime(), stateDir)
    const { file } = walletPaths(stateDir, "fresh")
    const content = readFileSync(file, "utf8")
    const phrase = content.trimEnd()
    expect(content).toBe(`${phrase}\n`)
    expect(phrase.split(" ")).toHaveLength(words)
    expect(validateMnemonic(phrase, wordlist)).toBe(true)
    expect(mode(file)).toBe(0o600)
    expect(readdirSync(walletPaths(stateDir, "fresh").dir)).toEqual(["wallet"])

    const derived = await walletAccounts("fresh", fakeRuntime(), stateDir)
    const [account] = derived.accounts
    expect(result).toEqual({ label: "fresh", file, kind: "phrase", words, evm: account?.evm, solana: account?.solana })
    expect(JSON.stringify(result)).not.toContain(phrase)
    expect(holdsKeyMaterial(result)).toBe(false)
  })

  test("two creates make different phrases", async () => {
    await createWallet("one", 12, fakeRuntime(), stateDir)
    await createWallet("two", 12, fakeRuntime(), stateDir)
    expect(readFileSync(walletPaths(stateDir, "one").file, "utf8")).not.toBe(
      readFileSync(walletPaths(stateDir, "two").file, "utf8"),
    )
  })

  test("a second create on a label is refused before a phrase is made, and the first file is untouched", async () => {
    await createWallet("fresh", 24, fakeRuntime(), stateDir)
    const { file } = walletPaths(stateDir, "fresh")
    const before = readFileSync(file, "utf8")
    const generate = spyOn(bip39, "generateMnemonic")
    try {
      const error = await expectRefusal("invalid_argument", () => createWallet("fresh", 12, fakeRuntime(), stateDir))
      expect(error.message).toBe(`Wallet "fresh" already exists at ${file}; a wallet is never overwritten.`)
      expect(generate).not.toHaveBeenCalled()
    } finally {
      generate.mockRestore()
    }
    expect(readFileSync(file, "utf8")).toBe(before)
  })

  test("a label with a file put there by hand is refused and its file is untouched", async () => {
    const file = writeWallet(stateDir, "main", HARDHAT_PHRASE)
    await expectRefusal("invalid_argument", () => createWallet("main", 12, fakeRuntime(), stateDir))
    expect(readFileSync(file, "utf8")).toBe(HARDHAT_PHRASE)
  })

  test("a label whose variable is set is refused and nothing is written", async () => {
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: "" })
    const error = await expectRefusal("invalid_argument", () => createWallet("main", 12, runtime, stateDir))
    expect(error.message).toContain("WEB3_TOOLS_WALLET_MAIN is set")
    expect(readdirSync(stateDir)).toEqual([])
  })

  test("a word count other than 12 and 24 is refused and nothing is written", async () => {
    await expectRefusal("invalid_argument", () => createWallet("main", 15 as 12, fakeRuntime(), stateDir))
    await expectRefusal("invalid_argument", () =>
      createWallet("main", "toString" as unknown as 12, fakeRuntime(), stateDir),
    )
    expect(readdirSync(stateDir)).toEqual([])
  })

  test("a failure while the phrase is held is a fixed message", async () => {
    const generate = spyOn(bip39, "generateMnemonic").mockImplementation(() => {
      throw new Error(HARDHAT_PHRASE)
    })
    try {
      const error = await expectRefusal("internal_error", () => createWallet("main", 12, fakeRuntime(), stateDir))
      expect(error.message).toBe('The signer failed while making a phrase for wallet "main".')
    } finally {
      generate.mockRestore()
    }
    expect(readdirSync(stateDir)).toEqual([])
  })

  test("a read-back that does not match is reported as possibly written", async () => {
    const write = await writeInstead(ABANDON_PHRASE)
    try {
      const error = await expectRefusal("internal_error", () => createWallet("main", 12, fakeRuntime(), stateDir))
      expect(error.message).toContain("Do not fund it")
    } finally {
      write.mockRestore()
    }
  })
})

describe("refuseWhileVariableSet", () => {
  test("passes when the label's variable is unset", () => {
    expect(() => refuseWhileVariableSet("main", fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: undefined }))).not.toThrow()
  })

  test("refuses a variable of the label", () => {
    expect(() => refuseWhileVariableSet("default", fakeRuntime({ WEB3_TOOLS_WALLET_DEFAULT: "" }))).toThrow(
      "WEB3_TOOLS_WALLET_DEFAULT is set",
    )
  })
})
