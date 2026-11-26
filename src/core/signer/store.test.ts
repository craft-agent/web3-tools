import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { join } from "node:path"
import { isToolError } from "../errors"
import type { ErrorCode } from "../errors"
import { walletPaths } from "./labels"
import { refuseExistingWallet, writeWalletFile } from "./store"
import { HARDHAT_PHRASE, holdsKeyMaterial, makeStateDir, writeWallet } from "./testing"

let stateDir: string

beforeEach(() => {
  stateDir = makeStateDir()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

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
  return error
}

describe("writeWalletFile", () => {
  test("writes the text to the label's file with mode 600 in directories of mode 700, and leaves no temporary file", async () => {
    const { root, accounts, dir, file } = walletPaths(stateDir, "main")
    const path = await writeWalletFile(stateDir, "main", `${HARDHAT_PHRASE}\n`)
    expect(path).toBe(file)
    expect(readFileSync(file, "utf8")).toBe(`${HARDHAT_PHRASE}\n`)
    expect(mode(file)).toBe(0o600)
    for (const directory of [root, accounts, dir]) expect(mode(directory)).toBe(0o700)
    expect(readdirSync(dir)).toEqual(["wallet"])
  })

  test("creates a state root that does not exist yet", async () => {
    const path = await writeWalletFile(join(stateDir, "new", "root"), "main", "x")
    expect(readFileSync(path, "utf8")).toBe("x")
  })

  test("refuses a second write to a label, leaves its file as it was and names the path", async () => {
    const first = await writeWalletFile(stateDir, "main", "first")
    const error = await expectRefusal("invalid_argument", () => writeWalletFile(stateDir, "main", HARDHAT_PHRASE))
    expect(error.message).toBe(`Wallet "main" already exists at ${first}; a wallet is never overwritten.`)
    expect(readFileSync(first, "utf8")).toBe("first")
    expect(mode(first)).toBe(0o600)
    expect(readdirSync(walletPaths(stateDir, "main").dir)).toEqual(["wallet"])
  })

  test("refuses a label whose file was put there by hand, whatever it is, and leaves it", async () => {
    const written = writeWallet(stateDir, "hand", "by hand", 0o644)
    await expectRefusal("invalid_argument", () => writeWalletFile(stateDir, "hand", HARDHAT_PHRASE))
    expect(readFileSync(written, "utf8")).toBe("by hand")
    expect(mode(written)).toBe(0o644)

    const { dir, file } = walletPaths(stateDir, "dangling")
    mkdirSync(dir, { recursive: true })
    symlinkSync(join(stateDir, "nowhere"), file)
    await expectRefusal("invalid_argument", () => writeWalletFile(stateDir, "dangling", HARDHAT_PHRASE))
    expect(readdirSync(dir)).toEqual(["wallet"])
  })

  test("refuses a link where the label's directory should be and writes nothing through it", async () => {
    const { accounts, dir } = walletPaths(stateDir, "main")
    const elsewhere = join(stateDir, "elsewhere")
    mkdirSync(accounts, { recursive: true })
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, dir)
    const error = await expectRefusal("forbidden", () => writeWalletFile(stateDir, "main", HARDHAT_PHRASE))
    expect(error.message).toContain(dir)
    expect(readdirSync(elsewhere)).toEqual([])
  })

  test("refuses a bad label and a relative state directory without writing", async () => {
    await expectRefusal("invalid_argument", () => writeWalletFile(stateDir, "Bad Label", HARDHAT_PHRASE))
    await expectRefusal("internal_error", () => writeWalletFile("relative/state", "main", HARDHAT_PHRASE))
    expect(readdirSync(stateDir)).toEqual([])
  })
})

describe("writeWalletFile: failures", () => {
  test("an unexpected failure becomes a fixed message with the system code, no cause, and leaves no temporary file", async () => {
    const link = spyOn(fsPromises, "link").mockRejectedValue(
      Object.assign(new Error(`could not link ${HARDHAT_PHRASE}`), { code: "EPERM" }),
    )
    try {
      const error = await expectRefusal("internal_error", () => writeWalletFile(stateDir, "main", HARDHAT_PHRASE))
      expect(error.message).toBe('The signer failed while writing wallet "main" (EPERM).')
      expect(error.cause).toBeUndefined()
    } finally {
      link.mockRestore()
    }
    expect(readdirSync(walletPaths(stateDir, "main").dir)).toEqual([])
  })

  test("a failure while writing the temporary file removes it and publishes nothing", async () => {
    const probe = await fsPromises.open(join(stateDir, "probe"), "w")
    const write = spyOn(Object.getPrototypeOf(probe), "writeFile").mockRejectedValue(new Error(HARDHAT_PHRASE))
    await probe.close()
    try {
      const error = await expectRefusal("internal_error", () => writeWalletFile(stateDir, "main", HARDHAT_PHRASE))
      expect(error.message).toBe('The signer failed while writing wallet "main".')
    } finally {
      write.mockRestore()
    }
    expect(readdirSync(walletPaths(stateDir, "main").dir)).toEqual([])
  })

  test("a directory that cannot be flushed does not fail the write", async () => {
    const { dir, file } = walletPaths(stateDir, "main")
    const realOpen = fsPromises.open
    const open = spyOn(fsPromises, "open").mockImplementation(((path: string, ...rest: unknown[]) =>
      path === dir ? Promise.reject(new Error("no flush")) : (realOpen as Function)(path, ...rest)) as never)
    try {
      expect(await writeWalletFile(stateDir, "main", "text")).toBe(file)
      expect(open.mock.calls.some(([path]) => path === dir)).toBe(true)
    } finally {
      open.mockRestore()
    }
    expect(readFileSync(file, "utf8")).toBe("text")
    expect(readdirSync(dir)).toEqual(["wallet"])
  })
})

describe("refuseExistingWallet", () => {
  test("passes where nothing stands, even below a state root that does not exist", async () => {
    await refuseExistingWallet(stateDir, "main")
    await refuseExistingWallet(join(stateDir, "absent"), "main")
    writeFileSync(join(stateDir, "accounts"), "a file in the way")
    await refuseExistingWallet(stateDir, "main")
  })

  test("refuses a label that has a file, naming the path", async () => {
    const file = writeWallet(stateDir, "main", "text")
    const error = await expectRefusal("invalid_argument", () => refuseExistingWallet(stateDir, "main"))
    expect(error.message).toContain(file)
  })
})
