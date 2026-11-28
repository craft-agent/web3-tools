import { concatBytes } from "@noble/hashes/utils.js"
import { base58, base64 } from "@scure/base"
import { ToolError } from "../errors"
import { SOLANA_ADDRESS_BYTES, solanaAddressBytes } from "./address"
import type { SolanaAccountMeta, SolanaInstruction } from "./instructions"

/** What a legacy message is made of: who pays, the blockhash that dates it and the instructions it runs. */
export type SolanaMessage = { feePayer: string; recentBlockhash: string; instructions: SolanaInstruction[] }

/** The most bytes of a signed transaction: a network packet less its headers. */
export const MAX_TRANSACTION_BYTES = 1232

/** The most accounts a message names: an instruction indexes them with one byte. */
const MAX_ACCOUNTS = 256

/** The byte length of an ed25519 signature. */
export const SIGNATURE_BYTES = 64

/** The byte length of a message's header: three counts. */
const HEADER_BYTES = 3

/** The largest value of a compact-u16. */
const MAX_COMPACT_U16 = 0xffff

/** The bits of a compact-u16's byte that hold the value; the top bit says another byte follows. */
const COMPACT_VALUE_BITS = 7
const COMPACT_VALUE_MASK = 0x7f
const COMPACT_CONTINUES = 0x80

/** The most bytes of a compact-u16, and the largest value its last byte holds. */
const COMPACT_MAX_BYTES = 3
const COMPACT_LAST_BYTE_MAX = 3

function refuse(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** The compact-u16 of `value`, Solana's variable length count: 7 bits a byte, low bits first. */
export function compactU16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > MAX_COMPACT_U16) {
    throw refuse(`A count in a transaction is a whole number from 0 to ${MAX_COMPACT_U16}.`)
  }
  const bytes: number[] = []
  let rest = value
  while (rest > COMPACT_VALUE_MASK) {
    bytes.push((rest & COMPACT_VALUE_MASK) | COMPACT_CONTINUES)
    rest >>= COMPACT_VALUE_BITS
  }
  bytes.push(rest)
  return Uint8Array.from(bytes)
}

/**
 * The compact-u16 at `offset` of `bytes` and the bytes it takes. A longer form
 * than the shortest, one over 65535 and one cut short are `invalid_argument`.
 */
export function decodeCompactU16(bytes: Uint8Array, offset = 0): { value: number; length: number } {
  let value = 0
  for (let index = 0; index < COMPACT_MAX_BYTES; index++) {
    const byte = bytes[offset + index]
    const alias = index > 0 && byte === 0
    const overflow = index === COMPACT_MAX_BYTES - 1 && byte > COMPACT_LAST_BYTE_MAX
    if (byte === undefined || alias || overflow) throw refuse("A count in the message is not a compact-u16.")
    value += (byte & COMPACT_VALUE_MASK) * 2 ** (COMPACT_VALUE_BITS * index)
    if ((byte & COMPACT_CONTINUES) === 0) return { value, length: index + 1 }
  }
  throw refuse("A count in the message is not a compact-u16.")
}

/** Reads bytes front to back, refusing what a message cannot hold. */
class Reader {
  position = 0

  constructor(private readonly bytes: Uint8Array) {}

  take(length: number): Uint8Array {
    if (this.position + length > this.bytes.length) throw refuse("The message ends before its fields do.")
    const taken = this.bytes.slice(this.position, this.position + length)
    this.position += length
    return taken
  }

  byte(): number {
    return this.take(1)[0]
  }

  compact(): number {
    const { value, length } = decodeCompactU16(this.bytes, this.position)
    this.position += length
    return value
  }

  finish(): void {
    if (this.position !== this.bytes.length) throw refuse("The message has bytes after its last field.")
  }
}

/** The compact-u16 of a count and then the bytes. */
function counted(bytes: Uint8Array, count = bytes.length): Uint8Array {
  return concatBytes(compactU16(count), bytes)
}

type Entry = { bytes: Uint8Array; signer: boolean; writable: boolean }

/** The order of an account's group: signer and writable, signer, writable, neither. */
function groupOf({ signer, writable }: Entry): number {
  return (signer ? 0 : 2) + (writable ? 0 : 1)
}

function blockhashBytes(text: string): Uint8Array {
  let bytes: Uint8Array | undefined
  try {
    bytes = base58.decode(text)
  } catch {
    bytes = undefined
  }
  if (bytes?.length !== SOLANA_ADDRESS_BYTES) throw refuse("The recent blockhash must be base58 text of 32 bytes.")
  return bytes
}

/** The accounts of `message` by address: the fee payer, then each instruction's program and accounts, permissions merged. */
function collectAccounts({ feePayer, instructions }: SolanaMessage): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  const add = (address: string, name: string, signer: boolean, writable: boolean) => {
    const found = entries.get(address)
    if (found === undefined) {
      entries.set(address, { bytes: solanaAddressBytes(address, name), signer, writable })
    } else {
      found.signer ||= signer
      found.writable ||= writable
    }
  }
  add(feePayer, "fee payer", true, true)
  for (const { programId, accounts } of instructions) {
    add(programId, "program id", false, false)
    for (const { address, signer, writable } of accounts) add(address, "account", signer, writable)
  }
  return entries
}

/**
 * The bytes a legacy message signs: its header, account keys, blockhash and
 * instructions. The fee payer is the first account and signs and pays; the
 * rest are in four groups (signer and writable, signer, writable, read only),
 * each in the order the accounts first appear, and an account named twice has
 * every permission any use asks of it. A program is a read-only account.
 *
 * More than 256 accounts, a transaction over 1232 bytes once signed, or an
 * address or blockhash that is not base58 of 32 bytes is `invalid_argument`.
 */
export function compileLegacyMessage(message: SolanaMessage): Uint8Array {
  const blockhash = blockhashBytes(message.recentBlockhash)
  const entries = collectAccounts(message)
  if (entries.size > MAX_ACCOUNTS) throw refuse(`A transaction names at most ${MAX_ACCOUNTS} accounts.`)

  const ordered = [...entries].sort(([, a], [, b]) => groupOf(a) - groupOf(b))
  const positions = new Map(ordered.map(([address], index) => [address, index]))
  const indexOf = (address: string): number => {
    const index = positions.get(address)
    if (index === undefined) throw new ToolError("internal_error", "An account of the message was not collected.")
    return index
  }
  const keys = ordered.map(([, entry]) => entry)
  const header = Uint8Array.of(
    keys.filter((key) => key.signer).length,
    keys.filter((key) => key.signer && !key.writable).length,
    keys.filter((key) => !key.signer && !key.writable).length,
  )
  const compiled = message.instructions.map(({ programId, accounts, data }) => {
    const indexes = Uint8Array.from(accounts, ({ address }) => indexOf(address))
    return concatBytes(Uint8Array.of(indexOf(programId)), counted(indexes), counted(data))
  })
  const bytes = concatBytes(
    header,
    counted(concatBytes(...keys.map((key) => key.bytes)), keys.length),
    blockhash,
    counted(concatBytes(...compiled), compiled.length),
  )

  const signed = compactU16(header[0]).length + header[0] * SIGNATURE_BYTES + bytes.length
  if (signed > MAX_TRANSACTION_BYTES) {
    throw refuse(`The transaction would be ${signed} bytes once signed; the most is ${MAX_TRANSACTION_BYTES}.`)
  }
  return bytes
}

/**
 * The message `bytes` hold, each account with the permissions its place in the
 * message gives it: an inverse of {@link compileLegacyMessage} for what that
 * produces. Anything that is not a well-formed legacy message is `invalid_argument`.
 */
export function decodeLegacyMessage(bytes: Uint8Array): SolanaMessage {
  const reader = new Reader(bytes)
  const [required, readonlySigned, readonlyUnsigned] = reader.take(HEADER_BYTES)
  const keys = Array.from({ length: reader.compact() }, () => reader.take(SOLANA_ADDRESS_BYTES))
  if (
    required < 1 ||
    required > keys.length ||
    readonlySigned >= required ||
    readonlyUnsigned > keys.length - required
  ) {
    throw refuse("The message header does not fit its accounts.")
  }
  const metas: SolanaAccountMeta[] = keys.map((key, index) => {
    const signer = index < required
    const writable = signer ? index < required - readonlySigned : index < keys.length - readonlyUnsigned
    return { address: base58.encode(key), signer, writable }
  })
  const recentBlockhash = base58.encode(reader.take(SOLANA_ADDRESS_BYTES))
  const instructions = Array.from({ length: reader.compact() }, (): SolanaInstruction => {
    const program = metas[reader.byte()]
    const accounts = Array.from({ length: reader.compact() }, () => metas[reader.byte()])
    const data = reader.take(reader.compact())
    if (program === undefined || accounts.some((account) => account === undefined)) {
      throw refuse("An instruction of the message names an account it does not have.")
    }
    return { programId: program.address, accounts: accounts.map((account) => ({ ...account })), data }
  })
  reader.finish()
  return { feePayer: metas[0].address, recentBlockhash, instructions }
}

/** The transaction: the compact-u16 count of `signatures`, each 64 bytes, then `message`. */
export function serializeTransaction(signatures: readonly Uint8Array[], message: Uint8Array): Uint8Array {
  if (signatures.length !== message[0]) {
    throw new ToolError("internal_error", "A transaction holds one signature for each account that signs.")
  }
  if (signatures.some((signature) => signature.length !== SIGNATURE_BYTES)) {
    throw new ToolError("internal_error", `A signature is ${SIGNATURE_BYTES} bytes.`)
  }
  return concatBytes(compactU16(signatures.length), ...signatures, message)
}

/** The base64 of {@link serializeTransaction}, the form `sendTransaction` and `simulateTransaction` take. */
export function transactionBase64(signatures: readonly Uint8Array[], message: Uint8Array): string {
  return base64.encode(serializeTransaction(signatures, message))
}

/**
 * The transaction of `message` with a zero signature for each account that
 * signs, for `simulateTransaction` with `sigVerify: false` and
 * `replaceRecentBlockhash: true`. No key is read, and the network rejects it
 * if sent.
 */
export function unsignedTransactionBase64(message: Uint8Array): string {
  return transactionBase64(
    Array.from({ length: message[0] }, () => new Uint8Array(SIGNATURE_BYTES)),
    message,
  )
}
