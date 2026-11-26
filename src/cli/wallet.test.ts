import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { solanaAddress } from "../core/signer/derive"
import { walletPaths } from "../core/signer/labels"
import {
  HARDHAT_KEY_0,
  HARDHAT_PHRASE,
  holdsKeyMaterial,
  makeStateDir,
  SOLANA_KEYPAIR_JSON,
} from "../core/signer/testing"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./command-io"
import { cli } from "./testing"

const HARDHAT_EVM_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const HARDHAT_SOLANA_0 = "oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96"
const SOLANA_KEY_ADDRESS = solanaAddress(new Uint8Array(32).fill(7))
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

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

describe("wallet import", () => {
  test("reads a phrase from standard input, stores it and prints account 0 on both families, never the phrase", async () => {
    const run = await cli(["wallet", "import", "--state-dir", stateDir], `${HARDHAT_PHRASE}\n`)

    const file = walletFile()
    expect(run.code).toBe(EXIT_OK)
    expect(run.stdout).toBe(
      [
        `Imported wallet "default" into ${file} (mode 600): a seed phrase of 12 words.`,
        `EVM account 0: ${HARDHAT_EVM_0}`,
        `Solana account 0: ${HARDHAT_SOLANA_0}`,
        "Nothing was sent to a chain.",
        "",
      ].join("\n"),
    )
    expect(run.stderr).toBe("")
    expect(holdsKeyMaterial(run)).toBe(false)
    expect(readFileSync(file, "utf8")).toBe(`${HARDHAT_PHRASE}\n`)
    expect(mode(file)).toBe(0o600)
  })

  test("an EVM key prints the EVM address alone", async () => {
    const run = await cli(["wallet", "import", "--state-dir", stateDir], HARDHAT_KEY_0)

    expect(run.code).toBe(EXIT_OK)
    expect(run.stdout).toContain("an EVM private key.")
    expect(run.stdout).toContain(`EVM account 0: ${HARDHAT_EVM_0}`)
    expect(run.stdout).not.toContain("Solana")
    expect(holdsKeyMaterial(run)).toBe(false)
  })

  test("a Solana keypair prints the Solana address alone", async () => {
    const run = await cli(["wallet", "import", "--state-dir", stateDir], SOLANA_KEYPAIR_JSON)

    expect(run.code).toBe(EXIT_OK)
    expect(run.stdout).toContain("a Solana keypair.")
    expect(run.stdout).toContain(`Solana account 0: ${SOLANA_KEY_ADDRESS}`)
    expect(run.stdout).not.toContain("EVM")
    expect(holdsKeyMaterial(run)).toBe(false)
  })

  test("--account names the label, in either form of the flag", async () => {
    const spaced = await cli(["wallet", "import", "--account", "work", "--state-dir", stateDir], HARDHAT_KEY_0)
    const equals = await cli(["wallet", "import", "--account=other", `--state-dir=${stateDir}`], HARDHAT_KEY_0)

    expect(spaced.code).toBe(EXIT_OK)
    expect(spaced.stdout).toContain('Imported wallet "work"')
    expect(equals.code).toBe(EXIT_OK)
    expect(readdirSync(join(stateDir, "accounts"))).toEqual(["other", "work"])
  })

  test("--state-dir decides where the wallet is kept, ahead of the environment", async () => {
    const fromEnvironment = makeStateDir()
    try {
      const run = await cli(["wallet", "import", "--state-dir", stateDir], HARDHAT_KEY_0, {
        env: { DEMO_STATE_DIR: fromEnvironment },
      })

      expect(run.code).toBe(EXIT_OK)
      expect(readdirSync(join(stateDir, "accounts"))).toEqual(["default"])
      expect(readdirSync(fromEnvironment)).toEqual([])
    } finally {
      rmSync(fromEnvironment, { recursive: true, force: true })
    }
  })

  test("while the label's variable is set it refuses without reading standard input, and writes nothing", async () => {
    const run = await cli(["wallet", "import", "--state-dir", stateDir], "", {
      env: { DEMO_WALLET_DEFAULT: HARDHAT_KEY_0 },
      readStdin: MUST_NOT_READ,
    })

    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain("DEMO_WALLET_DEFAULT is set")
    expect(run.stdout).toBe("")
    expect(MUST_NOT_READ).not.toHaveBeenCalled()
    expect(holdsKeyMaterial(run)).toBe(false)
    expect(readdirSync(stateDir)).toEqual([])
  })

  test("a label that has a wallet is refused before standard input is read, and its file is kept", async () => {
    const first = await cli(["wallet", "import", "--state-dir", stateDir], HARDHAT_KEY_0)
    expect(first.code).toBe(EXIT_OK)
    const file = join(stateDir, "accounts", "default", "wallet")
    const before = readFileSync(file, "utf8")
    const readStdin = mock(async () => "")

    const run = await cli(["wallet", "import", "--state-dir", stateDir], "", { readStdin })

    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain("already exists")
    expect(readStdin).not.toHaveBeenCalled()
    expect(readFileSync(file, "utf8")).toBe(before)
  })

  test.each([
    ["empty", ""],
    ["blank", " \n\t"],
  ])("input that is %s asks for the key and writes nothing", async (_name, input) => {
    const run = await cli(["wallet", "import", "--state-dir", stateDir], input)

    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toBe("web3-tools-cli: Give the key on standard input.\n")
    expect(readdirSync(stateDir)).toEqual([])
  })

  test("input that is not a key fails with one line that does not repeat it, and writes nothing", async () => {
    const run = await cli(["wallet", "import", "--state-dir", stateDir], "hunter2 is my password")

    expect(run.code).toBe(EXIT_FAILED)
    expect(run.stdout).toBe("")
    expect(run.stderr).toContain('The key of wallet "default"')
    expect(run.stderr).not.toContain("hunter2")
    expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
    expect(readdirSync(stateDir)).toEqual([])
  })

  test("a label that has a wallet is refused and its file is untouched", async () => {
    await cli(["wallet", "import", "--state-dir", stateDir], HARDHAT_KEY_0)

    const run = await cli(["wallet", "import", "--state-dir", stateDir], HARDHAT_PHRASE)

    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain("already exists")
    expect(readFileSync(walletFile(), "utf8")).toBe(`${HARDHAT_KEY_0}\n`)
  })

  test("a failure of standard input is said generically, without its detail", async () => {
    const run = await cli(["wallet", "import", "--state-dir", stateDir], "", {
      readStdin: async () => {
        throw new Error(HARDHAT_KEY_0)
      },
    })

    expect(run.code).toBe(EXIT_FAILED)
    expect(run.stderr).toBe("web3-tools-cli: Unexpected error; the command failed.\n")
  })
})

describe("wallet: the command line", () => {
  test.each([
    ["no subcommand", ["wallet"]],
    ["an unknown subcommand", ["wallet", "remove"]],
    ["a key as the subcommand", ["wallet", HARDHAT_KEY_0]],
    ["a key as an extra argument of import", ["wallet", "import", HARDHAT_KEY_0]],
    ["a key as an extra argument of create", ["wallet", "create", HARDHAT_KEY_0]],
    ["an unknown flag holding a key", ["wallet", "import", `--key=${HARDHAT_KEY_0}`]],
    ["a flag of create given to import", ["wallet", "import", "--words", "12"]],
  ])("%s is a usage error that repeats nothing of it", async (_name, argv) => {
    const run = await cli(argv, "", { readStdin: MUST_NOT_READ })

    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stdout).toBe("")
    expect(run.stderr).toMatch(/^web3-tools-cli: \S.*\n$/)
    expect(run.stderr).not.toContain(HARDHAT_KEY_0.slice(2, 22))
    expect(run.stderr).not.toContain("remove")
    expect(MUST_NOT_READ).not.toHaveBeenCalled()
  })

  test.each([["import"], ["create"]])(
    "%s with a key as its --account is refused without quoting it",
    async (command) => {
      const run = await cli(["wallet", command, "--account", HARDHAT_KEY_0, "--state-dir", stateDir], "", {
        readStdin: MUST_NOT_READ,
      })

      expect(run.code).toBe(EXIT_USAGE)
      expect(run.stderr).toContain("Invalid label:")
      expect(run.stderr).not.toContain(HARDHAT_KEY_0.slice(2, 22))
      expect(MUST_NOT_READ).not.toHaveBeenCalled()
      expect(readdirSync(stateDir)).toEqual([])
    },
  )

  test("a flag without its value is a usage error naming the flag", async () => {
    const run = await cli(["wallet", "import", "--account"], "", { readStdin: MUST_NOT_READ })

    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stderr).toContain("--account needs a value")
  })
})
