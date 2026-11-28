import { ed25519 } from "@noble/curves/ed25519.js"
import { base58, base64 } from "@scure/base"
import { compileLegacyMessage, serializeTransaction, type SolanaMessage } from "./message"

/** A key the tests sign with; its address is `testAddress(index)`. */
export type TestKeypair = { seed: Uint8Array; address: string }

const SEED_BYTES = 32
const SEED_FILL = 7

/** The key of `index`, a number below 65536: each index gives its own. */
export function testKeypair(index: number): TestKeypair {
  const seed = new Uint8Array(SEED_BYTES).fill(SEED_FILL)
  new DataView(seed.buffer).setUint16(0, index)
  return { seed, address: base58.encode(ed25519.getPublicKey(seed)) }
}

/**
 * `message` signed as the cluster takes it, base64: one signature for each account that signs, from `signers` in the
 * order the message names them (the fee payer first).
 */
export function signedTransactionBase64(message: SolanaMessage, ...signers: TestKeypair[]): string {
  const bytes = compileLegacyMessage(message)
  const signatures = signers.map(({ seed }) => ed25519.sign(bytes, seed))
  return base64.encode(serializeTransaction(signatures, bytes))
}
