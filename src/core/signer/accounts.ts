import { base58 } from "@scure/base"
import { isToolError, ToolError } from "../errors"
import type { ToolRuntime } from "../runtime"
import { evmAddress, evmSecretsOf, MAX_ACCOUNT_INDEX, phraseSeed, solanaAddress, solanaSeedOf } from "./derive"
import { KEY_BYTES, keyMaterial } from "./keys"
import type { Family, KeyKind, WalletKey } from "./keys"
import { checkLabel, listLabels } from "./labels"
import { readWalletKey } from "./source"
import type { KeySource } from "./source"

/** One account of a wallet: its address on each family the wallet opens. */
export type Account = {
  /** The account's index in a seed phrase; `null` for a lone key. */
  index: number | null
  evm?: string
  solana?: string
}

/** A wallet's key kind, where it comes from and the accounts asked of it. */
export type WalletAccounts = { label: string; source: KeySource; kind: KeyKind; words?: number; accounts: Account[] }

/** Which accounts of a seed phrase to derive: `count` of them from index `from`. */
type AccountRange = { from: number; count: number }

/** The wallet that owns an address, and its account index in a seed phrase (`null` for a lone key). */
type AddressOwner = { label: string; index: number | null }

/** Every address of the user's own wallets, by family, and the labels whose key could not be read. */
export type OwnAddresses = {
  /** Lowercase `0x…` addresses. */
  evm: Map<string, AddressOwner>
  /** Base58 addresses. */
  solana: Map<string, AddressOwner>
  unreadable: string[]
}

/** `label#index`: decimal digits with no leading zero. */
const ACCOUNT_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/

const ACCOUNT_SEPARATOR = "#"

/** How a family's key is named and what it acts on, for the refusal of a key of the other family. */
const FAMILY_WORDS: Record<Family, { key: string; acts: string }> = {
  evm: { key: "an EVM", acts: "EVM chains" },
  solana: { key: "a Solana", acts: "Solana" },
}

type Material = ReturnType<typeof keyMaterial>

/**
 * Runs `work` on a copy of the key's material and zeroes the copy after. A
 * failure that is not a refusal is replaced by a fixed message, since it may
 * hold the material.
 */
function holding<T>(key: WalletKey, label: string, work: (material: Material) => T): T {
  const material = keyMaterial(key)
  try {
    return work(material)
  } catch (error) {
    if (isToolError(error)) throw error
    throw new ToolError("internal_error", `The signer failed while deriving the accounts of wallet "${label}".`)
  } finally {
    material.secret?.fill(0)
  }
}

function evmAddressesOf(seed: Uint8Array, indexes: readonly number[]): string[] {
  const secrets = evmSecretsOf(seed, indexes)
  try {
    return secrets.map((secret) => evmAddress(secret))
  } finally {
    for (const secret of secrets) secret.fill(0)
  }
}

function solanaAddressOf(seed: Uint8Array, index: number): string {
  const secret = solanaSeedOf(seed, index)
  try {
    return solanaAddress(secret)
  } finally {
    secret.fill(0)
  }
}

function phraseAccounts(phrase: string, { from, count }: AccountRange): Account[] {
  const indexes = Array.from({ length: count }, (_, offset) => from + offset)
  const seed = phraseSeed(phrase)
  try {
    const evm = evmAddressesOf(seed, indexes)
    return indexes.map((index, offset) => ({ index, evm: evm[offset], solana: solanaAddressOf(seed, index) }))
  } finally {
    seed.fill(0)
  }
}

function loneAccount(kind: KeyKind, secret: Uint8Array): Account {
  return kind === "evm"
    ? { index: null, evm: evmAddress(secret) }
    : { index: null, solana: base58.encode(secret.subarray(KEY_BYTES)) }
}

/** The accounts `range` names of `key` when it is a seed phrase, else its one account. */
function accountsOf(key: WalletKey, label: string, range: AccountRange): Account[] {
  return holding(key, label, ({ phrase, secret }) => {
    if (phrase !== undefined) return phraseAccounts(phrase, range)
    if (secret === undefined) throw new ToolError("internal_error", `Wallet "${label}" holds no key material.`)
    return [loneAccount(key.kind, secret)]
  })
}

function checkRange({ from, count }: AccountRange): void {
  const last = from + count - 1
  if (!Number.isInteger(from) || !Number.isInteger(count) || from < 0 || count < 1 || last > MAX_ACCOUNT_INDEX) {
    throw new ToolError(
      "invalid_argument",
      `The account range is out of bounds: "from" is a whole number from 0, "count" a whole number from 1, and the last account (from + count - 1) is #${MAX_ACCOUNT_INDEX} at most.`,
    )
  }
}

/**
 * The addresses of wallet `label`: for a seed phrase, `range.count` accounts
 * from `range.from` on both families (account #0 when no range is given); for
 * an EVM key or a Solana keypair, its one address with a `null` index. Nothing
 * of the key reaches the result or an error.
 */
export async function walletAccounts(
  label: string,
  runtime: ToolRuntime,
  stateDir: string,
  range: AccountRange = { from: 0, count: 1 },
): Promise<WalletAccounts> {
  checkRange(range)
  const { source, key } = await readWalletKey(label, runtime, stateDir)
  const accounts = accountsOf(key, label, range)
  return key.words === undefined
    ? { label, source, kind: key.kind, accounts }
    : { label, source, kind: key.kind, words: key.words, accounts }
}

/**
 * Every address the user owns, computed from the keys alone: accounts 0 to
 * `MAX_ACCOUNT_INDEX` of each seed phrase on both families, and each key's own
 * address. A label whose key cannot be read is listed in `unreadable`, so one
 * broken wallet does not hide the others. Never taken from an argument or a
 * file a caller can write.
 */
export async function ownAddresses(runtime: ToolRuntime, stateDir: string): Promise<OwnAddresses> {
  const own: OwnAddresses = { evm: new Map(), solana: new Map(), unreadable: [] }
  const range = { from: 0, count: MAX_ACCOUNT_INDEX + 1 }
  for (const { label } of await listLabels(runtime, stateDir)) {
    let accounts: Account[]
    try {
      accounts = accountsOf((await readWalletKey(label, runtime, stateDir)).key, label, range)
    } catch (error) {
      if (!isToolError(error)) throw error
      own.unreadable.push(label)
      continue
    }
    for (const { index, evm, solana } of accounts) {
      if (evm !== undefined && !own.evm.has(evm.toLowerCase())) own.evm.set(evm.toLowerCase(), { label, index })
      if (solana !== undefined && !own.solana.has(solana)) own.solana.set(solana, { label, index })
    }
  }
  return own
}

/**
 * Splits `label` or `label#index` (a whole number from 0 to `MAX_ACCOUNT_INDEX`
 * without leading zeros) into its parts; the index is `null` when left out.
 */
export function parseAccount(text: string): { label: string; index: number | null } {
  const separator = text.indexOf(ACCOUNT_SEPARATOR)
  if (separator === -1) return { label: checkLabel(text), index: null }
  const label = checkLabel(text.slice(0, separator))
  const digits = text.slice(separator + 1)
  if (!ACCOUNT_INDEX_PATTERN.test(digits) || Number(digits) > MAX_ACCOUNT_INDEX) {
    throw new ToolError(
      "invalid_argument",
      `Invalid account index after "${ACCOUNT_SEPARATOR}" in the account of wallet "${label}": use a whole number from 0 to ${MAX_ACCOUNT_INDEX} without leading zeros, as in "${label}${ACCOUNT_SEPARATOR}3".`,
    )
  }
  return { label, index: Number(digits) }
}

async function onlyLabel(runtime: ToolRuntime, stateDir: string): Promise<string> {
  const labels = (await listLabels(runtime, stateDir)).map((entry) => entry.label)
  if (labels.length === 1) return labels[0]
  if (labels.length === 0) {
    throw new ToolError(
      "invalid_argument",
      `No wallet is set up: run "${runtime.cli} wallet import" or set ${runtime.envPrefix}_WALLET_<LABEL>.`,
    )
  }
  throw new ToolError(
    "invalid_argument",
    `Several wallets are set up (${labels.join(", ")}); pick one with "account", as in "${labels[0]}".`,
  )
}

/**
 * The wallet and address that `account` names on `family`: `label` or
 * `label#index`; a seed phrase takes index 0 when none is given, a lone key has
 * no index. Left out, `account` is the only label there is; with none or
 * several it is `invalid_argument`. A key of the other family is refused.
 */
export async function resolveAccount(
  account: string | undefined,
  family: Family,
  runtime: ToolRuntime,
  stateDir: string,
): Promise<{ label: string; index: number | null; address: string }> {
  const { label, index: requested } =
    account === undefined ? { label: await onlyLabel(runtime, stateDir), index: null } : parseAccount(account)
  const { key } = await readWalletKey(label, runtime, stateDir)
  const isPhrase = key.kind === "phrase"
  if (!isPhrase && key.kind !== family) {
    throw new ToolError(
      "invalid_argument",
      `Wallet "${label}" holds ${FAMILY_WORDS[key.kind].key} key, which cannot act on ${FAMILY_WORDS[family].acts}.`,
    )
  }
  if (!isPhrase && requested !== null && requested !== 0) {
    throw new ToolError(
      "invalid_argument",
      `Wallet "${label}" holds a single key and has no account #${requested}; use "${label}".`,
    )
  }
  const index = isPhrase ? (requested ?? 0) : null
  const [resolved] = accountsOf(key, label, { from: index ?? 0, count: 1 })
  const address = resolved?.[family]
  if (address === undefined) {
    throw new ToolError("internal_error", `The signer found no ${family} address for wallet "${label}".`)
  }
  return { label, index, address }
}
