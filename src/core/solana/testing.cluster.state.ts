import { base58, base64 } from "@scure/base"
import { formatAmount } from "../amount"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { SOLANA_ADDRESS_BYTES } from "./address"

/** An extension as the node's `jsonParsed` shows it: its camelCase name and its state, absent for one that has none. */
export type FakeExtension = { extension: string; state?: Record<string, unknown> }

type Account = { lamports: bigint; owner: string; executable: boolean; space: number }

/** An account that holds no token state: a wallet, a program, a nonce account, a metadata account. */
export type PlainEntry = Account & { kind: "plain"; data: Uint8Array }

/** A token mint; `owner` is its token program. */
export type MintEntry = Account & {
  kind: "mint"
  decimals: number
  supply: bigint
  mintAuthority: string | null
  freezeAuthority: string | null
  extensions: FakeExtension[]
}

/** A token account; `owner` is its token program and `holder` the wallet that owns the tokens. */
export type TokenEntry = Account & {
  kind: "token"
  mint: string
  holder: string
  amount: bigint
  delegate: string | null
  delegatedAmount: bigint
  state: "initialized" | "frozen"
  extensions: FakeExtension[]
}

/** What the fake cluster holds at an address. */
export type FakeEntry = PlainEntry | MintEntry | TokenEntry

/** Every account of the cluster, by address. */
export type FakeAccounts = Map<string, FakeEntry>

/** The bytes the rent formula counts on top of an account's data. */
export const ACCOUNT_OVERHEAD_BYTES = 128

/** Lamports per byte the cluster charges for rent exemption: 650,240 for an account of no data and 1,488,440 for 165 bytes. */
export const DEFAULT_LAMPORTS_PER_BYTE = 5080n

/** The bytes of a token mint and of a token account, without extensions. */
export const MINT_BYTES = 82
export const TOKEN_ACCOUNT_BYTES = 165

/** The bytes of an account type and of an extension's type and length, which Token-2022 adds to an account with extensions. */
const ACCOUNT_TYPE_BYTES = 1
const EXTENSION_HEADER_BYTES = 4

const U64_BYTES = 8

/** A Solana `COption<Pubkey>`: a u32 tag and the address. */
const OPTION_ADDRESS_BYTES = 4 + SOLANA_ADDRESS_BYTES

const PROGRAM_NAMES: Readonly<Record<string, string>> = {
  [SOLANA_PROGRAMS.tokenProgram]: "spl-token",
  [SOLANA_PROGRAMS.token2022Program]: "spl-token-2022",
}

/** The lamports an account of `space` bytes must hold to be rent exempt at `lamportsPerByte`. */
export function rentMinimum(space: number, lamportsPerByte: bigint): bigint {
  return BigInt(ACCOUNT_OVERHEAD_BYTES + space) * lamportsPerByte
}

/**
 * The space of a mint (`baseBytes` 82) or token account (165) of `program` with `extensionCount` extensions: the base
 * layout for the Token program or without extensions; for Token-2022 with some, the 165 bytes of the account layout, the
 * account type and a header for each extension. The payloads of the extensions are not counted.
 */
export function tokenSpace(program: string, baseBytes: number, extensionCount: number): number {
  if (program === SOLANA_PROGRAMS.tokenProgram || extensionCount === 0) return baseBytes
  return TOKEN_ACCOUNT_BYTES + ACCOUNT_TYPE_BYTES + EXTENSION_HEADER_BYTES * extensionCount
}

function tokenAmount(amount: bigint, decimals: number): Record<string, unknown> {
  return {
    amount: amount.toString(),
    decimals,
    uiAmount: Number(amount) / 10 ** decimals,
    uiAmountString: formatAmount(amount, decimals),
  }
}

function withExtensions(extensions: readonly FakeExtension[]): { extensions?: FakeExtension[] } {
  return extensions.length === 0 ? {} : { extensions: [...extensions] }
}

function putOption(bytes: Uint8Array, offset: number, address: string | null): void {
  if (address === null) return
  new DataView(bytes.buffer).setUint32(offset, 1, true)
  bytes.set(base58.decode(address), offset + 4)
}

function putU64(bytes: Uint8Array, offset: number, value: bigint): void {
  new DataView(bytes.buffer).setBigUint64(offset, value, true)
}

/** The base layout of a mint or token account, padded to its space; the TLV of extensions is not encoded. */
function encodeTokenState(entry: MintEntry | TokenEntry): Uint8Array {
  const bytes = new Uint8Array(entry.space)
  if (entry.kind === "mint") {
    putOption(bytes, 0, entry.mintAuthority)
    putU64(bytes, OPTION_ADDRESS_BYTES, entry.supply)
    bytes[OPTION_ADDRESS_BYTES + U64_BYTES] = entry.decimals
    bytes[OPTION_ADDRESS_BYTES + U64_BYTES + 1] = 1
    putOption(bytes, OPTION_ADDRESS_BYTES + U64_BYTES + 2, entry.freezeAuthority)
    return bytes
  }
  bytes.set(base58.decode(entry.mint), 0)
  bytes.set(base58.decode(entry.holder), SOLANA_ADDRESS_BYTES)
  putU64(bytes, SOLANA_ADDRESS_BYTES * 2, entry.amount)
  putOption(bytes, SOLANA_ADDRESS_BYTES * 2 + U64_BYTES, entry.delegate)
  const stateOffset = SOLANA_ADDRESS_BYTES * 2 + U64_BYTES + OPTION_ADDRESS_BYTES
  bytes[stateOffset] = entry.state === "frozen" ? 2 : 1
  putU64(bytes, stateOffset + 1 + 12, entry.delegatedAmount)
  return bytes
}

function parsedData(entry: MintEntry | TokenEntry, accounts: FakeAccounts): Record<string, unknown> {
  const program = PROGRAM_NAMES[entry.owner]
  if (entry.kind === "mint") {
    const info = {
      mintAuthority: entry.mintAuthority,
      supply: entry.supply.toString(),
      decimals: entry.decimals,
      isInitialized: true,
      freezeAuthority: entry.freezeAuthority,
      ...withExtensions(entry.extensions),
    }
    return { program, parsed: { type: "mint", info }, space: entry.space }
  }
  const mint = accounts.get(entry.mint)
  const decimals = mint?.kind === "mint" ? mint.decimals : 0
  const info = {
    mint: entry.mint,
    owner: entry.holder,
    tokenAmount: tokenAmount(entry.amount, decimals),
    state: entry.state,
    isNative: false,
    ...(entry.delegate === null
      ? {}
      : { delegate: entry.delegate, delegatedAmount: tokenAmount(entry.delegatedAmount, decimals) }),
    ...withExtensions(entry.extensions),
  }
  return { program, parsed: { type: "account", info }, space: entry.space }
}

/**
 * The account at `address` as `getAccountInfo` answers it, or `null`. `jsonParsed` shows mints and token accounts
 * parsed and every other account as base64, as a node does; `base64` shows all as bytes.
 */
export function accountValue(
  accounts: FakeAccounts,
  address: string,
  encoding: "jsonParsed" | "base64",
): Record<string, unknown> | null {
  const entry = accounts.get(address)
  if (entry === undefined) return null
  const shared = {
    lamports: Number(entry.lamports),
    owner: entry.owner,
    executable: entry.executable,
    rentEpoch: Number.MAX_SAFE_INTEGER,
    space: entry.space,
  }
  if (entry.kind !== "plain" && encoding === "jsonParsed") return { ...shared, data: parsedData(entry, accounts) }
  const bytes = entry.kind === "plain" ? entry.data : encodeTokenState(entry)
  return { ...shared, data: [base64.encode(bytes), "base64"] }
}
