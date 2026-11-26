import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as bip39 from "@scure/bip39"
import { validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { walletAccounts } from "../core/signer/accounts"
import { walletPaths } from "../core/signer/labels"
import { ABANDON_PHRASE, fakeRuntime, holdsKeyMaterial, makeStateDir } from "../core/signer/testing"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./command-io"
import { cli } from "./testing"

const MUST_NOT_READ = mock(async (): Promise<string> => "")

let stateDir: string

beforeEach(() => {
  stateDir = makeStateDir()
  MUST_NOT_READ.mockClear()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

function walletFile(label = "default"): string {
  return walletPaths(stateDir, label).file
}

describe("wallet create", () => {
  test("makes a 24-word phrase by default and prints the addresses of account 0, never the phrase", async () => {
    const run = await cli(["wallet", "create", "--state-dir", stateDir])

    const file = walletFile()
    const phrase = readFileSync(file, "utf8").trimEnd()
    const [account] = (await walletAccounts("default", fakeRuntime(), stateDir)).accounts
    expect(run.code).toBe(EXIT_OK)
    expect(run.stdout).toBe(
      [
        `Created wallet "default" in ${file} (mode 600): a new 24-word seed phrase no one has seen.`,
        `EVM account 0: ${account?.evm}`,
        `Solana account 0: ${account?.solana}`,
        "Back the phrase up before funding it: it exists only in that file. Read it yourself, never through an agent.",
        "",
      ].join("\n"),
    )
    expect(run.stderr).toBe("")
    expect(phrase.split(" ")).toHaveLength(24)
    expect(validateMnemonic(phrase, wordlist)).toBe(true)
    expect(run.stdout).not.toContain(phrase)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("--words 12 makes a 12-word phrase", async () => {
    const run = await cli(["wallet", "create", "--words", "12", "--account=main", "--state-dir", stateDir])

    expect(run.code).toBe(EXIT_OK)
    expect(run.stdout).toContain('Created wallet "main"')
    expect(run.stdout).toContain("a new 12-word seed phrase")
    expect(readFileSync(walletFile("main"), "utf8").trimEnd().split(" ")).toHaveLength(12)
  })

  test("no word of the phrase reaches standard output or standard error", async () => {
    const generate = spyOn(bip39, "generateMnemonic").mockReturnValue(ABANDON_PHRASE)
    try {
      const run = await cli(["wallet", "create", "--words", "12", "--state-dir", stateDir])

      expect(run.code).toBe(EXIT_OK)
      expect(readFileSync(walletFile(), "utf8")).toBe(`${ABANDON_PHRASE}\n`)
      expect(holdsKeyMaterial(run)).toBe(false)
      expect(run.stdout + run.stderr).not.toMatch(/abandon|about/)
    } finally {
      generate.mockRestore()
    }
  })

  test("--state-dir decides where the wallet is kept, ahead of the environment", async () => {
    const fromEnvironment = makeStateDir()
    try {
      const run = await cli(["wallet", "create", "--state-dir", stateDir], "", {
        env: { DEMO_STATE_DIR: fromEnvironment },
      })

      expect(run.code).toBe(EXIT_OK)
      expect(readdirSync(stateDir)).toEqual(["accounts"])
      expect(readdirSync(fromEnvironment)).toEqual([])
    } finally {
      rmSync(fromEnvironment, { recursive: true, force: true })
    }
  })

  test.each([["15"], ["x"], ["012"]])("--words %s is a usage error and writes nothing", async (words) => {
    const run = await cli(["wallet", "create", "--words", words, "--state-dir", stateDir])

    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toBe("web3-tools-cli: Option --words takes 12 or 24.\n")
    expect(readdirSync(stateDir)).toEqual([])
  })

  test("a second create on a label is refused and the first phrase stays", async () => {
    await cli(["wallet", "create", "--state-dir", stateDir])
    const first = readFileSync(walletFile(), "utf8")

    const run = await cli(["wallet", "create", "--state-dir", stateDir])

    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toBe(
      `web3-tools-cli: Wallet "default" already exists at ${walletFile()}; a wallet is never overwritten.\n`,
    )
    expect(run.stdout).toBe("")
    expect(readFileSync(walletFile(), "utf8")).toBe(first)
  })

  test("while the label's variable is set it refuses and writes nothing", async () => {
    const run = await cli(["wallet", "create", "--account", "main", "--state-dir", stateDir], "", {
      env: { DEMO_WALLET_MAIN: "" },
    })

    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain("DEMO_WALLET_MAIN is set")
    expect(readdirSync(stateDir)).toEqual([])
  })

  test("a state directory that is a file is refused as a failure without a stack", async () => {
    const notADirectory = join(stateDir, "file")
    writeFileSync(notADirectory, "x")

    const run = await cli(["wallet", "create", "--state-dir", notADirectory])

    expect(run.code).toBe(EXIT_FAILED)
    expect(run.stderr).toBe(
      `web3-tools-cli: "${notADirectory}" exists and is not a directory (a symlink is not followed).\n`,
    )
  })

  test("never reads standard input", async () => {
    const run = await cli(["wallet", "create", "--state-dir", stateDir], "", { readStdin: MUST_NOT_READ })

    expect(run.code).toBe(EXIT_OK)
    expect(MUST_NOT_READ).not.toHaveBeenCalled()
  })
})
