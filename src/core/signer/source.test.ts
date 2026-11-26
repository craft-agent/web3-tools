import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { isToolError } from "../errors"
import type { ErrorCode } from "../errors"
import { keyMaterial } from "./keys"
import { walletPaths } from "./labels"
import { MAX_KEY_BYTES, readWalletKey } from "./source"
import { fakeRuntime, HARDHAT_KEY_0, HARDHAT_PHRASE, makeStateDir, SOLANA_KEYPAIR_JSON, writeWallet } from "./testing"

let stateDir: string

beforeEach(() => {
  stateDir = makeStateDir()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

async function failure(label: string, env: Record<string, string | undefined> = {}): Promise<Error> {
  try {
    await readWalletKey(label, fakeRuntime(env), stateDir)
  } catch (error) {
    return error as Error
  }
  throw new Error("readWalletKey did not refuse")
}

async function expectRefusal(code: ErrorCode, label = "main"): Promise<Error> {
  const error = await failure(label)
  expect(isToolError(error) && error.code).toBe(code)
  return error
}

describe("readWalletKey: the variable", () => {
  test("reads the label's variable and never the file", async () => {
    writeWallet(stateDir, "main", HARDHAT_PHRASE)
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: HARDHAT_KEY_0 })
    const { source, key } = await readWalletKey("main", runtime, stateDir)
    expect(source).toBe("variable")
    expect(key.kind).toBe("evm")
  })

  test("wins when it is empty or invalid, and the file is not consulted", async () => {
    writeWallet(stateDir, "main", HARDHAT_PHRASE)
    const empty = await failure("main", { WEB3_TOOLS_WALLET_MAIN: "" })
    expect(empty.message).toBe('The key of wallet "main" is empty.')
    const invalid = await failure("main", { WEB3_TOOLS_WALLET_MAIN: "hunter2" })
    expect(invalid.message).toContain("is not a seed phrase")
    expect(invalid.message).not.toContain("hunter2")
  })

  test("needs no state directory content", async () => {
    const { source } = await readWalletKey(
      "default",
      fakeRuntime({ WEB3_TOOLS_WALLET_DEFAULT: SOLANA_KEYPAIR_JSON }),
      stateDir,
    )
    expect(source).toBe("variable")
  })

  test("is the variable of the label's upper case, under the runtime's prefix", async () => {
    const runtime = fakeRuntime({ OTHER_WALLET_MAIN: HARDHAT_KEY_0, WEB3_TOOLS_WALLET_main: HARDHAT_KEY_0 })
    const error = await readWalletKey("main", runtime, stateDir).catch((caught: Error) => caught)
    expect(isToolError(error) && error.code).toBe("unauthenticated")
  })

  test("replaces a failure that is not a refusal with a fixed message and no cause", async () => {
    const booby = {
      trim: () => {
        throw new Error("leaks hunter2")
      },
    } as unknown as string
    const error = await failure("main", { WEB3_TOOLS_WALLET_MAIN: booby })
    expect(isToolError(error) && error.code).toBe("internal_error")
    expect(error.message).toBe('The signer failed while reading wallet "main".')
    expect("cause" in error).toBe(false)
  })

  test("refuses a bad label before reading anything", async () => {
    const error = await failure("Main", { WEB3_TOOLS_WALLET_MAIN: HARDHAT_KEY_0 })
    expect(isToolError(error) && error.code).toBe("invalid_argument")
  })
})

describe("readWalletKey: the file", () => {
  test("reads a 600 file, and a 400 one", async () => {
    for (const mode of [0o600, 0o400]) {
      writeWallet(stateDir, "main", `${HARDHAT_PHRASE}\n`, mode)
      const { source, key } = await readWalletKey("main", fakeRuntime(), stateDir)
      expect(source).toBe("file")
      expect(keyMaterial(key).phrase).toBe(HARDHAT_PHRASE)
      rmSync(walletPaths(stateDir, "main").dir, { recursive: true })
    }
  })

  test("names the variable and the command when the wallet is missing", async () => {
    const expected =
      'No wallet "main": set WEB3_TOOLS_WALLET_MAIN or run "web3-tools-cli wallet import --account main".'
    expect((await expectRefusal("unauthenticated")).message).toBe(expected)
    rmSync(writeWallet(stateDir, "main", HARDHAT_PHRASE))
    expect((await expectRefusal("unauthenticated")).message).toBe(expected)
    rmSync(stateDir, { recursive: true })
    expect((await expectRefusal("unauthenticated")).message).toBe(expected)
  })

  test("refuses a file that others can reach, with the chmod hint", async () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o602]) {
      const file = writeWallet(stateDir, "main", HARDHAT_PHRASE, mode)
      const error = await expectRefusal("forbidden")
      expect(error.message).toBe(
        `The wallet file ${file} can be read or written by other users; run chmod 600 ${JSON.stringify(file)}.`,
      )
      expect(error.message).not.toContain("test test")
      rmSync(walletPaths(stateDir, "main").dir, { recursive: true })
    }
  })

  test("refuses a link to a valid 600 file, which is never followed", async () => {
    const target = join(stateDir, "elsewhere")
    writeFileSync(target, HARDHAT_PHRASE, { mode: 0o600 })
    const file = writeWallet(stateDir, "main", "x")
    rmSync(file)
    symlinkSync(target, file)
    const error = await expectRefusal("forbidden")
    expect(error.message).toContain("is a link")
  })

  test("refuses a directory at the file path", async () => {
    const file = writeWallet(stateDir, "main", "x")
    rmSync(file)
    mkdirSync(file)
    const error = await expectRefusal("forbidden")
    expect(error.message).toContain("not a regular file")
  })

  test("refuses a file larger than the limit as unauthenticated", async () => {
    writeWallet(stateDir, "main", `${HARDHAT_PHRASE}${" ".repeat(MAX_KEY_BYTES)}`)
    expect((await expectRefusal("unauthenticated")).message).toContain(`larger than ${MAX_KEY_BYTES} bytes`)
  })

  test("reads a file of exactly the limit", async () => {
    writeWallet(stateDir, "main", `${HARDHAT_KEY_0}${"\n".repeat(MAX_KEY_BYTES - HARDHAT_KEY_0.length)}`)
    expect((await readWalletKey("main", fakeRuntime(), stateDir)).key.kind).toBe("evm")
  })

  test("reports an empty or invalid file without quoting it", async () => {
    writeWallet(stateDir, "main", "")
    expect((await expectRefusal("unauthenticated")).message).toContain("is empty")
    writeWallet(stateDir, "main", "hunter2 secret")
    const error = await expectRefusal("unauthenticated")
    expect(error.message).not.toMatch(/hunter2|secret$/)
  })

  test("reports a file it cannot open as unauthenticated with the code", async () => {
    const file = writeWallet(stateDir, "main", HARDHAT_PHRASE, 0o000)
    if (process.getuid?.() === 0) return
    const error = await expectRefusal("unauthenticated")
    expect(error.message).toBe(`The wallet file ${file} could not be read (EACCES).`)
  })
})

describe("readWalletKey: the directories", () => {
  test("refuses a linked label directory", async () => {
    writeWallet(stateDir, "real", HARDHAT_PHRASE)
    symlinkSync(join(stateDir, "accounts", "real"), join(stateDir, "accounts", "main"))
    expect((await expectRefusal("forbidden")).message).toContain("is a link, not a directory")
  })

  test("refuses a linked accounts directory and a linked state root", async () => {
    writeWallet(stateDir, "main", HARDHAT_PHRASE)
    renameSync(join(stateDir, "accounts"), join(stateDir, "real-accounts"))
    symlinkSync(join(stateDir, "real-accounts"), join(stateDir, "accounts"))
    await expectRefusal("forbidden")

    const link = `${stateDir}-link`
    symlinkSync(stateDir, link)
    try {
      const error = await readWalletKey("main", fakeRuntime(), link).catch((caught: Error) => caught)
      expect(isToolError(error) && error.code).toBe("forbidden")
    } finally {
      rmSync(link)
    }
  })

  test("refuses directories that others can write to", async () => {
    writeWallet(stateDir, "main", HARDHAT_PHRASE)
    const { root, accounts, dir } = walletPaths(stateDir, "main")
    for (const path of [accounts, dir, root]) {
      for (const mode of [0o770, 0o707]) {
        chmodSync(path, mode)
        const error = await expectRefusal("forbidden")
        expect(error.message).toContain(`The wallet directory ${path}`)
        expect(error.message).toContain('before using wallet "main"')
      }
      chmodSync(path, 0o700)
    }
    expect((await readWalletKey("main", fakeRuntime(), stateDir)).source).toBe("file")
  })

  test("refuses a file where a directory should be", async () => {
    writeFileSync(join(stateDir, "accounts"), "x")
    expect((await expectRefusal("forbidden")).message).toContain("is a link, not a directory")
    rmSync(join(stateDir, "accounts"))
    const { dir } = walletPaths(stateDir, "main")
    rmSync(dirname(writeWallet(stateDir, "main", HARDHAT_PHRASE)), { recursive: true })
    writeFileSync(dir, "x")
    expect((await expectRefusal("forbidden")).message).toContain("is a link, not a directory")
  })
})
