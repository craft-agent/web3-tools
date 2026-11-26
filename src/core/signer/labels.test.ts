import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isToolError } from "../errors"
import { DEFAULT_LABEL, checkLabel, isLabel, listLabels, walletPaths, walletVariable } from "./labels"
import { fakeRuntime, makeStateDir, writeWallet } from "./testing"

let stateDir: string

beforeEach(() => {
  stateDir = makeStateDir()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

function failure(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe("isLabel and checkLabel", () => {
  const valid = [DEFAULT_LABEL, "a", "0", "work_2", "a_b", "a" + "0".repeat(22) + "b", "a".repeat(24)]
  const invalid = [
    "",
    "a".repeat(25),
    "Work",
    "DEFAULT",
    "_work",
    "work_",
    "_",
    "work-1",
    "work.1",
    "work/1",
    "..",
    "w w",
  ]

  test("accepts valid labels", () => {
    for (const label of valid) {
      expect(isLabel(label)).toBe(true)
      expect(checkLabel(label)).toBe(label)
    }
  })

  test("refuses invalid labels as invalid_argument stating the rule", () => {
    for (const label of invalid) {
      expect(isLabel(label)).toBe(false)
      const error = failure(() => checkLabel(label))
      expect(isToolError(error) && error.code).toBe("invalid_argument")
      expect((error as Error).message).toContain("1 to 24 lowercase letters")
    }
  })

  test("quotes at most 40 characters of a bad label", () => {
    const message = (failure(() => checkLabel("X".repeat(100))) as Error).message
    expect(message).toContain(`"${"X".repeat(40)}…"`)
    expect(message).not.toContain("X".repeat(41))
  })
})

describe("walletVariable and walletPaths", () => {
  test("names the variable with the prefix and the upper-cased label", () => {
    expect(walletVariable("default", "WEB3_TOOLS")).toBe("WEB3_TOOLS_WALLET_DEFAULT")
    expect(walletVariable("main_2", "WEB3_TOOLS")).toBe("WEB3_TOOLS_WALLET_MAIN_2")
  })

  test("puts every path under the state root", () => {
    expect(walletPaths("/state", "main")).toEqual({
      root: "/state",
      accounts: "/state/accounts",
      dir: "/state/accounts/main",
      file: "/state/accounts/main/wallet",
    })
  })

  test("refuses a relative state root as internal_error", () => {
    const error = failure(() => walletPaths("state", "main"))
    expect(isToolError(error) && error.code).toBe("internal_error")
  })
})

describe("listLabels", () => {
  test("is empty without variables or an accounts directory", async () => {
    expect(await listLabels(fakeRuntime(), stateDir)).toEqual([])
  })

  test("lists variables and files, sorted and unique, the variable winning", async () => {
    writeWallet(stateDir, "zeta", "x")
    writeWallet(stateDir, "main", "x")
    writeWallet(stateDir, "b2", "x")
    const env = {
      WEB3_TOOLS_WALLET_MAIN: "",
      WEB3_TOOLS_WALLET_ALPHA: "anything",
      WEB3_TOOLS_WALLET_B2: undefined,
    }
    expect(await listLabels(fakeRuntime(env), stateDir)).toEqual([
      { label: "alpha", source: "variable" },
      { label: "b2", source: "file" },
      { label: "main", source: "variable" },
      { label: "zeta", source: "file" },
    ])
  })

  test("ignores variables and entries that are not labels", async () => {
    const env = {
      WEB3_TOOLS_WALLET_: "x",
      WEB3_TOOLS_WALLET__BAD: "x",
      WEB3_TOOLS_WALLET_BAD_: "x",
      "WEB3_TOOLS_WALLET_has-dash": "x",
      WEB3_TOOLS_WALLET_lower: "x",
      WEB3_TOOLS_WALLET_TOO_LONG_FOR_A_LABEL_AT_ALL: "x",
      OTHER_WALLET_MAIN: "x",
      WEB3_TOOLS_WALLETS_MAIN: "x",
    }
    for (const name of ["Upper", "bad-name", "_bad", "a".repeat(25)]) writeWallet(stateDir, name, "x")
    writeWallet(stateDir, "ok", "x")
    expect(await listLabels(fakeRuntime(env), stateDir)).toEqual([{ label: "ok", source: "file" }])
  })

  test("lists a directory only when it holds an entry named wallet, of any type", async () => {
    mkdirSync(join(stateDir, "accounts", "empty"), { recursive: true })
    writeFileSync(join(stateDir, "accounts", "plain"), "x")
    mkdirSync(join(stateDir, "accounts", "other"))
    writeFileSync(join(stateDir, "accounts", "other", "notwallet"), "x")
    mkdirSync(join(stateDir, "accounts", "dirwallet", "wallet"), { recursive: true })
    mkdirSync(join(stateDir, "accounts", "broken"))
    symlinkSync(join(stateDir, "missing"), join(stateDir, "accounts", "broken", "wallet"))
    expect(await listLabels(fakeRuntime(), stateDir)).toEqual([
      { label: "broken", source: "file" },
      { label: "dirwallet", source: "file" },
    ])
  })

  test("treats an accounts entry that is not a directory as empty", async () => {
    writeFileSync(join(stateDir, "accounts"), "x")
    expect(await listLabels(fakeRuntime(), stateDir)).toEqual([])
  })

  test("reports a directory it cannot read instead of hiding it", async () => {
    writeWallet(stateDir, "main", "x")
    chmodSync(join(stateDir, "accounts"), 0o000)
    try {
      const outcome = await listLabels(fakeRuntime(), stateDir).then(
        () => undefined,
        (error: unknown) => error,
      )
      // Skipped where the user can read anything, such as root.
      if (process.getuid?.() !== 0) expect(outcome).toBeInstanceOf(Error)
    } finally {
      chmodSync(join(stateDir, "accounts"), 0o700)
    }
  })
})
