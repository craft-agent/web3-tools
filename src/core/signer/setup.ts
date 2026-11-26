import { generateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { isToolError, ToolError } from "../errors"
import type { ToolRuntime } from "../runtime"
import { firstAccount } from "./accounts"
import type { Account } from "./accounts"
import { parseKey } from "./keys"
import type { KeyKind, WalletKey } from "./keys"
import { checkLabel, walletVariable } from "./labels"
import { readWalletKey } from "./source"
import { refuseExistingWallet, writeWalletFile } from "./store"

/** The word counts of a new phrase, with the bits of entropy each is made of. */
const NEW_PHRASE_ENTROPY_BITS: Readonly<Record<12 | 24, number>> = { 12: 128, 24: 256 }

/** What a person's setup of a wallet made: where it is and its account 0, never the key. */
export type SetupResult = {
  label: string
  file: string
  kind: KeyKind
  /** The word count of a seed phrase. */
  words?: number
  /** The EIP-55 address of account 0, for a key that signs on EVM chains. */
  evm?: string
  /** The base58 address of account 0, for a key that signs on Solana. */
  solana?: string
}

/**
 * Runs `work`, which holds a key; a failure that is not a refusal is replaced
 * by a fixed message, since it may hold the key.
 */
function holding<T>(label: string, step: string, work: () => T): T {
  try {
    return work()
  } catch (error) {
    if (isToolError(error)) throw error
    throw new ToolError("internal_error", `The signer failed while ${step} wallet "${label}".`)
  }
}

/**
 * Refuses with `invalid_argument` while the variable of wallet `label` is set:
 * the key is read from it, so a file would never be read. A person's command
 * calls it before asking for a key.
 */
export function refuseWhileVariableSet(label: string, runtime: ToolRuntime): void {
  checkLabel(label)
  const variable = walletVariable(label, runtime.envPrefix)
  if (runtime.env[variable] !== undefined) {
    throw new ToolError(
      "invalid_argument",
      `${variable} is set, so wallet "${label}" is read from it and a file would never be read; unset it to keep the key in a file.`,
    )
  }
}

/**
 * Refuses a label that cannot take a new wallet file: one whose variable is
 * set, or one that has a wallet already. A person's command calls it before
 * asking for a key, so no one pastes a key only to have it refused.
 */
export async function refuseUnwritableWallet(label: string, runtime: ToolRuntime, stateDir: string): Promise<void> {
  refuseWhileVariableSet(label, runtime)
  await refuseExistingWallet(stateDir, label)
}

/** Whether the file just written reads back as the key `expected` was derived from. */
async function readsBackAs(
  label: string,
  kind: KeyKind,
  expected: Account,
  runtime: ToolRuntime,
  stateDir: string,
): Promise<boolean> {
  try {
    const { source, key } = await readWalletKey(label, runtime, stateDir)
    const actual = firstAccount(key, label)
    return source === "file" && key.kind === kind && actual.evm === expected.evm && actual.solana === expected.solana
  } catch {
    return false
  }
}

/**
 * Writes `text`, the text of `key`, as the wallet file of `label`, then reads
 * it back and checks that it gives the same account 0, so a file that was
 * changed on its way to disk is never left looking like a good one.
 */
async function storeKey(
  label: string,
  key: WalletKey,
  text: string,
  runtime: ToolRuntime,
  stateDir: string,
): Promise<SetupResult> {
  const expected = firstAccount(key, label)
  const file = await writeWalletFile(stateDir, label, `${text}\n`)
  if (!(await readsBackAs(label, key.kind, expected, runtime, stateDir))) {
    throw new ToolError(
      "internal_error",
      `Wallet "${label}" may have been written to ${file}, but it could not be read back as written. Do not fund it: check the file, and delete it by hand if it is wrong.`,
    )
  }
  return {
    label,
    file,
    kind: key.kind,
    ...(key.words !== undefined && { words: key.words }),
    ...(expected.evm !== undefined && { evm: expected.evm }),
    ...(expected.solana !== undefined && { solana: expected.solana }),
  }
}

/**
 * Stores the key in `text` as the wallet file of `label`, create-only: a seed
 * phrase, an EVM private key or a Solana keypair, as `parseKey` reads them. A
 * key that does not parse is refused and nothing is written, a label that has a
 * wallet is refused and its file is left as it is, and so is one whose variable
 * is set. Resolves to account 0's addresses, read back from the file.
 *
 * Only a person's command may call it, and no tool: the key is the person's own.
 */
export async function importWallet(
  label: string,
  text: string,
  runtime: ToolRuntime,
  stateDir: string,
): Promise<SetupResult> {
  checkLabel(label)
  refuseWhileVariableSet(label, runtime)
  const trimmed = text.trim()
  const key = holding(label, "checking the key of", () => parseKey(trimmed, label))
  return storeKey(label, key, trimmed, runtime, stateDir)
}

/**
 * Makes a new seed phrase of `words` words from the platform's cryptographic
 * randomness and stores it as the wallet file of `label`, create-only, with the
 * refusals of `importWallet`; a label that has a wallet is refused before any
 * phrase is made. The phrase goes to the file alone: it is never returned,
 * printed or thrown, and no one has seen it.
 */
export async function createWallet(
  label: string,
  words: 12 | 24,
  runtime: ToolRuntime,
  stateDir: string,
): Promise<SetupResult> {
  checkLabel(label)
  if (!Object.hasOwn(NEW_PHRASE_ENTROPY_BITS, words)) {
    throw new ToolError("invalid_argument", "A new seed phrase has 12 or 24 words.")
  }
  refuseWhileVariableSet(label, runtime)
  await refuseExistingWallet(stateDir, label)
  const phrase = holding(label, "making a phrase for", () => generateMnemonic(wordlist, NEW_PHRASE_ENTROPY_BITS[words]))
  const key = holding(label, "checking the key of", () => parseKey(phrase, label))
  return storeKey(label, key, phrase, runtime, stateDir)
}
