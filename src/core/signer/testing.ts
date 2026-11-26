import { ed25519 } from "@noble/curves/ed25519.js"
import { base58 } from "@scure/base"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolRuntime } from "../runtime"
import { walletPaths } from "./labels"

/** The phrase of Hardhat's default accounts. */
export const HARDHAT_PHRASE = "test test test test test test test test test test test junk"

/** A valid 12-word phrase made of one word and its checksum word. */
export const ABANDON_PHRASE = `${"abandon ".repeat(11)}about`

/** The private key of the first Hardhat account. */
export const HARDHAT_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

const SOLANA_SEED = new Uint8Array(32).fill(7)

const SOLANA_KEYPAIR = new Uint8Array([...SOLANA_SEED, ...ed25519.getPublicKey(SOLANA_SEED)])

/** A Solana keypair as base58, the form Phantom exports. */
export const SOLANA_KEYPAIR_BASE58 = base58.encode(SOLANA_KEYPAIR)

/** The same keypair as a JSON array of numbers, the form the Solana CLI writes. */
export const SOLANA_KEYPAIR_JSON = JSON.stringify([...SOLANA_KEYPAIR])

/** Pieces of the keys above that no result and no error may carry. */
const KEY_FRAGMENTS = [
  HARDHAT_PHRASE,
  ABANDON_PHRASE,
  HARDHAT_KEY_0.slice(2),
  SOLANA_KEYPAIR_BASE58,
  SOLANA_KEYPAIR_JSON,
]

/** Whether `value`, serialized, or an error's name, message, cause and details, hold any piece of the keys above. */
export function holdsKeyMaterial(value: unknown): boolean {
  const parts =
    value instanceof Error
      ? [
          value.name,
          value.message,
          JSON.stringify(value),
          String(value.cause),
          JSON.stringify(Reflect.get(value, "details")),
        ]
      : [JSON.stringify(value)]
  const text = parts.join("\n")
  return KEY_FRAGMENTS.some((fragment) => text.includes(fragment))
}

/** The mode of a directory only its owner can use. */
const PRIVATE_DIR_MODE = 0o700

/** A runtime with the package's own names, `env` and the fields `overrides` replaces. */
export function fakeRuntime(
  env: Readonly<Record<string, string | undefined>> = {},
  overrides: Partial<ToolRuntime> = {},
): ToolRuntime {
  return { envPrefix: "WEB3_TOOLS", cli: "web3-tools-cli", env, now: () => 0, ...overrides }
}

/** A new state root under the temporary directory, mode 700; the test removes it. */
export function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "web3-state-"))
}

/** Writes `text` as the wallet file of `label`, creating `accounts/<label>/` with mode 700. */
export function writeWallet(stateDir: string, label: string, text: string, mode = 0o600): string {
  const { accounts, dir, file } = walletPaths(stateDir, label)
  for (const path of [accounts, dir]) {
    mkdirSync(path, { recursive: true })
    chmodSync(path, PRIVATE_DIR_MODE)
  }
  writeFileSync(file, text, { mode })
  chmodSync(file, mode)
  return file
}
