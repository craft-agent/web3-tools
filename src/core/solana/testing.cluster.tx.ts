import { ed25519 } from "@noble/curves/ed25519.js"
import { base58, base64 } from "@scure/base"
import { ToolError } from "../errors"
import { SOLANA_ADDRESS_BYTES } from "./address"
import { decodeCompactU16, decodeLegacyMessage, SIGNATURE_BYTES, type SolanaMessage } from "./message"

/** A transaction as a node reads it from its bytes. */
export type FakeSolanaTx = {
  /** The base58 of the first signature, which is the transaction's id. */
  signature: string
  message: SolanaMessage
  /** The signatures, one for each account that signs. */
  signatures: Uint8Array[]
  /** The bytes the signatures sign. */
  messageBytes: Uint8Array
  /** The accounts of the message in its order: the fee payer first. */
  keys: string[]
}

const HEADER_BYTES = 3

const INVALID_PREFIX = "invalid transaction: "

function invalid(reason: string): ToolError {
  return new ToolError("invalid_argument", `${INVALID_PREFIX}${reason}`)
}

/** The accounts of a legacy message in its own order; `decodeLegacyMessage` has checked the rest. */
function keysOf(messageBytes: Uint8Array): string[] {
  const { value: count, length } = decodeCompactU16(messageBytes, HEADER_BYTES)
  const start = HEADER_BYTES + length
  return Array.from({ length: count }, (_, index) =>
    base58.encode(messageBytes.slice(start + index * SOLANA_ADDRESS_BYTES, start + (index + 1) * SOLANA_ADDRESS_BYTES)),
  )
}

function parseTransaction(text: string): FakeSolanaTx {
  let bytes: Uint8Array
  try {
    bytes = base64.decode(text)
  } catch {
    throw invalid("the transaction is not base64")
  }
  const { value: count, length } = decodeCompactU16(bytes)
  const messageStart = length + count * SIGNATURE_BYTES
  if (bytes.length <= messageStart) throw invalid("the transaction ends before its message")
  const messageBytes = bytes.slice(messageStart)
  const message = decodeLegacyMessage(messageBytes)
  if (count !== messageBytes[0]) throw invalid("the signatures are not the ones the message requires")
  const signatures = Array.from({ length: count }, (_, index) =>
    bytes.slice(length + index * SIGNATURE_BYTES, length + (index + 1) * SIGNATURE_BYTES),
  )
  const [first] = signatures
  if (first === undefined) throw invalid("the transaction has no signature")
  return { signature: base58.encode(first), message, signatures, messageBytes, keys: keysOf(messageBytes) }
}

/** The transaction `text` holds, base64 of a legacy transaction; anything else is `invalid_argument`, worded as a node does. */
export function decodeTransaction(text: string): FakeSolanaTx {
  try {
    return parseTransaction(text)
  } catch (error) {
    if (error instanceof ToolError && !error.message.startsWith(INVALID_PREFIX)) throw invalid(error.message)
    throw error
  }
}

/** Whether every signature signs the message for its account, as ed25519 says. */
export function signaturesVerify({ signatures, messageBytes, keys }: FakeSolanaTx): boolean {
  return signatures.every((signature, index) => {
    try {
      return ed25519.verify(signature, messageBytes, base58.decode(keys[index]))
    } catch {
      return false
    }
  })
}
