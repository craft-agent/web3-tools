import { ed25519 } from "@noble/curves/ed25519.js"
import { base58, base64 } from "@scure/base"
import { ToolError } from "../errors"
import type { ToolRuntime } from "../runtime"
import { compileLegacyMessage, decodeCompactU16, serializeTransaction, SIGNATURE_BYTES } from "../solana/message"
import type { SolanaMessage } from "../solana/message"
import { checkKeyFits } from "./accounts"
import { phraseSeed, solanaAddress, solanaSeedOf } from "./derive"
import { holding } from "./holding"
import { KEY_BYTES } from "./keys"
import type { Sender } from "./sign"
import { readWalletKey } from "./source"

export type { SolanaMessage } from "../solana/message"

/** The `util.inspect` hook of Node and Bun. */
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom")

let bytesOf: (signed: SignedSolanaTransaction) => Uint8Array

/**
 * A signed Solana transaction. Its bytes live in a private field and never
 * reach a string: `JSON.stringify` gives `{ signature, from }`, `String`, a
 * template and `util.inspect` the signature alone.
 */
export class SignedSolanaTransaction {
  /** The base58 of the first signature, which is the transaction's id. */
  readonly signature: string
  /** The base58 address of the fee payer, the account that signed. */
  readonly from: string
  readonly #bytes: Uint8Array

  /** Takes the signed transaction's bytes over without copying them. */
  constructor(bytes: Uint8Array, from: string) {
    const start = decodeCompactU16(bytes).length
    if (bytes.length < start + SIGNATURE_BYTES) {
      throw new ToolError("internal_error", "A signed Solana transaction holds its first signature.")
    }
    this.signature = base58.encode(bytes.slice(start, start + SIGNATURE_BYTES))
    this.from = from
    this.#bytes = bytes
  }

  static {
    bytesOf = (signed) => signed.#bytes
  }

  toJSON(): { signature: string; from: string } {
    return { signature: this.signature, from: this.from }
  }

  toString(): string {
    return this.signature
  }

  [INSPECT_CUSTOM](): string {
    return this.toString()
  }
}

/**
 * The signed transaction as base64, for the request body of the broadcast
 * (`sendTransaction`).
 *
 * Only the module that broadcasts may call it, and the string must go nowhere
 * but that request body: not a result, an error, a log, a command line or a
 * file. It is not re-exported from `src/core/index.ts`.
 */
export function rawTransactionBase64(signed: SignedSolanaTransaction): string {
  return base64.encode(bytesOf(signed))
}

/** The 32-byte seed of account `index` of `phrase`; the phrase's seed is zeroed. */
function phraseSolanaSeed(phrase: string, index: number): Uint8Array {
  const seed = phraseSeed(phrase)
  try {
    return solanaSeedOf(seed, index)
  } finally {
    seed.fill(0)
  }
}

/** Signs `message` with `seed` for `sender`, which `seed` must open. */
function signWith(seed: Uint8Array, sender: Sender, message: Uint8Array): SignedSolanaTransaction {
  const address = solanaAddress(seed)
  if (address !== sender.address) {
    throw new ToolError("stale", `Wallet "${sender.label}" no longer opens ${sender.address}; nothing was signed.`)
  }
  const signature = ed25519.sign(message, seed)
  if (!ed25519.verify(signature, message, base58.decode(address))) {
    throw new ToolError("internal_error", `The signature for wallet "${sender.label}" does not verify.`)
  }
  return new SignedSolanaTransaction(serializeTransaction([signature], message), address)
}

/**
 * Signs `message` as `sender`: wallet `label`, account `index` of a seed
 * phrase (0 when `null`) or its lone Solana key. The message is compiled and
 * checked before the key is read: one that cannot be sent, a fee payer other
 * than `sender.address`, or a signer besides the fee payer is `invalid_argument`
 * (the package never co-signs). The address is derived again from the key and
 * must be `sender.address`, else the call fails as `stale` and signs nothing; a
 * key of another family, or an account other than #0 of a lone key, is
 * `invalid_argument`.
 *
 * Ed25519 signatures are deterministic: two signatures of one message are
 * equal, and so is the id. The signature is checked against the fee payer
 * before it is returned.
 *
 * Every copy of the secret is zeroed after. An error raised while the key is
 * held other than a refusal is replaced by a fixed message.
 */
export async function signSolanaTransaction(
  sender: Sender,
  message: SolanaMessage,
  runtime: ToolRuntime,
  stateDir: string,
): Promise<SignedSolanaTransaction> {
  const compiled = compileLegacyMessage(message)
  if (message.feePayer !== sender.address) {
    throw new ToolError(
      "invalid_argument",
      `The fee payer of the transaction must be ${sender.address}, the account that signs.`,
    )
  }
  if (compiled[0] !== 1) {
    throw new ToolError(
      "invalid_argument",
      `Only the fee payer ${sender.address} may sign the transaction; the package never co-signs.`,
    )
  }
  const { key } = await readWalletKey(sender.label, runtime, stateDir)
  checkKeyFits(key, sender.label, "solana", sender.index)
  return holding(key, sender.label, "signing for", ({ phrase, secret }) => {
    if (phrase !== undefined) {
      const seed = phraseSolanaSeed(phrase, sender.index ?? 0)
      try {
        return signWith(seed, sender, compiled)
      } finally {
        seed.fill(0)
      }
    }
    if (secret === undefined) {
      throw new ToolError("internal_error", `Wallet "${sender.label}" holds no key material.`)
    }
    const seed = secret.slice(0, KEY_BYTES)
    try {
      return signWith(seed, sender, compiled)
    } finally {
      seed.fill(0)
    }
  })
}
