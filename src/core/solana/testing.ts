import { ed25519 } from "@noble/curves/ed25519.js"
import { base58, base64 } from "@scure/base"
import { systemTransfer } from "./instructions"
import type { SolanaMessage } from "./message"

/**
 * A 49-lamport transfer and its serializations, as in micro-sol-signer's
 * `transaction` test (paulmillr/micro-sol-signer, test/basic.test.ts): the
 * sender's seed is 32 bytes of 8, and ed25519 signs without randomness, so the
 * signed bytes are reproducible.
 */
export const TRANSFER_VECTOR = {
  seed: new Uint8Array(32).fill(8),
  sender: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1",
  recipient: "J3dxNj7nDRRqRRXuEMynDG57DkZK4jYRuv3Garmb1i99",
  blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
  lamports: 49n,
  unsignedBase64:
    "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAEDE5j2LG0aRXxRumpLXz29L2n8qTIWIY3ImX5Ba9F9k8r9Q5/Mtmcn8onFxt47xKj+XdXXd3C8j/FcPu7csUrz/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxJrndgN4IFTxep3s6kO0ROug7bEsbx0xxuDkqEvwUusBAgIAAQwCAAAAMQAAAAAAAAA=",
  signedBase64:
    "AVuErQHaXv0SG0/PchunfxHKt8wMRfMZzqV0tkC5qO6owYxWU2v871AoWywGoFQr4z+q/7mE8lIufNl/kxj+nQ0BAAEDE5j2LG0aRXxRumpLXz29L2n8qTIWIY3ImX5Ba9F9k8r9Q5/Mtmcn8onFxt47xKj+XdXXd3C8j/FcPu7csUrz/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxJrndgN4IFTxep3s6kO0ROug7bEsbx0xxuDkqEvwUusBAgIAAQwCAAAAMQAAAAAAAAA=",
}

/** The message of {@link TRANSFER_VECTOR}, as the signer takes it. */
export const TRANSFER_MESSAGE: SolanaMessage = {
  feePayer: TRANSFER_VECTOR.sender,
  recentBlockhash: TRANSFER_VECTOR.blockhash,
  instructions: [systemTransfer(TRANSFER_VECTOR.sender, TRANSFER_VECTOR.recipient, TRANSFER_VECTOR.lamports)],
}

/** The bytes of the signed transaction of {@link TRANSFER_VECTOR}. */
export const TRANSFER_SIGNED_BYTES = base64.decode(TRANSFER_VECTOR.signedBase64)

/** The address of a key made from `index`, a number below 65536: each index gives its own. */
export function testAddress(index: number): string {
  const seed = new Uint8Array(32).fill(7)
  new DataView(seed.buffer).setUint16(0, index)
  return base58.encode(ed25519.getPublicKey(seed))
}
