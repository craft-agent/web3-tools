import { bytesToHex, hexToBytes } from "@noble/curves/utils.js"
import { parseEvmAddress } from "./address"

/** The byte length of an ABI word. */
export const WORD_BYTES = 32

/** The byte length of an ABI word, as hex digits. */
const WORD_DIGITS = WORD_BYTES * 2

/** `0x` and whole bytes of hex digits. */
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/

/** An ABI word: `value` as 64 hex digits. */
export function word(value: bigint): string {
  return value.toString(16).padStart(WORD_DIGITS, "0")
}

/** The ABI word of an address: its 40 digits, lower case, after 24 zeros. */
export function addressWord(address: string): string {
  return parseEvmAddress(address).slice(2).toLowerCase().padStart(WORD_DIGITS, "0")
}

/** `value` as the hex quantity JSON-RPC takes: `0x`, no leading zeros. */
export function quantityHex(value: bigint): string {
  return `0x${value.toString(16)}`
}

/** The bytes of `hex` (`0x` and whole bytes of hex digits), or `undefined` when it is anything else. */
export function bytesOfHex(hex: unknown): Uint8Array | undefined {
  return typeof hex === "string" && HEX_PATTERN.test(hex) ? hexToBytes(hex.slice(2)) : undefined
}

/** The ABI word at `index` of `bytes`; `bytes` must hold it. */
export function readWord(bytes: Uint8Array, index: number): bigint {
  return BigInt(`0x${bytesToHex(bytes.subarray(index * WORD_BYTES, (index + 1) * WORD_BYTES))}`)
}

/** `bytes` followed by zeros up to a whole number of words, as hex digits. */
function padded(bytes: Uint8Array): string {
  const digits = bytesToHex(bytes)
  return digits.padEnd(Math.ceil(digits.length / WORD_DIGITS) * WORD_DIGITS, "0")
}

/** The arguments of a call whose one parameter is `bytes`: the offset, the length and the padded data, as hex digits. */
export function bytesArgument(hex: string): string {
  const bytes = bytesOfHex(hex)
  if (!bytes) throw new TypeError("not hex data")
  return `${word(BigInt(WORD_BYTES))}${word(BigInt(bytes.length))}${padded(bytes)}`
}

/** `text` as the ABI encoding of a `string` return value: `0x`, the offset, the length and the padded UTF-8. */
export function abiString(text: string): string {
  const bytes = new TextEncoder().encode(text)
  return `0x${word(BigInt(WORD_BYTES))}${word(BigInt(bytes.length))}${padded(bytes)}`
}

/** The text of an ABI-encoded `string`, or `undefined` when `bytes` is not one or holds no UTF-8. */
export function decodeAbiString(bytes: Uint8Array): string | undefined {
  if (bytes.length < 2 * WORD_BYTES) return undefined
  const offset = readWord(bytes, 0)
  if (offset % BigInt(WORD_BYTES) !== 0n || offset + BigInt(WORD_BYTES) > BigInt(bytes.length)) return undefined
  const start = Number(offset) + WORD_BYTES
  const length = readWord(bytes, Number(offset) / WORD_BYTES)
  if (length > BigInt(bytes.length - start)) return undefined
  return decodeUtf8(bytes.subarray(start, start + Number(length)))
}

/** The text of `bytes` as UTF-8, or `undefined` when they are not valid UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}
