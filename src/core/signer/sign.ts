import { bytesToHex } from "@noble/curves/utils.js"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { ToolError } from "../errors"
import { prepareEvmTransaction } from "../evm/transaction"
import type { EvmTransaction, EvmTransactionRequest } from "../evm/transaction"
import type { ToolRuntime } from "../runtime"
import { checkKeyFits } from "./accounts"
import { evmAddress, evmSecretsOf, phraseSeed } from "./derive"
import { holding } from "./holding"
import { readWalletKey } from "./source"

export type { EvmTransactionRequest } from "../evm/transaction"

/** The `util.inspect` hook of Node and Bun. */
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom")

let bytesOf: (signed: SignedEvmTransaction) => Uint8Array

/**
 * A signed transaction. Its bytes live in a private field and never reach a
 * string: `JSON.stringify` gives `{ hash, from }`, `String`, a template and
 * `util.inspect` the hash alone.
 */
export class SignedEvmTransaction {
  /** `0x` and the 64 lower case hex digits of the Keccak-256 of the signed bytes. */
  readonly hash: string
  /** The EIP-55 address of the account that signed. */
  readonly from: string
  readonly #bytes: Uint8Array

  /** Takes the signed transaction's bytes over without copying them. */
  constructor(bytes: Uint8Array, from: string) {
    this.hash = `0x${bytesToHex(keccak_256(bytes))}`
    this.from = from
    this.#bytes = bytes
  }

  static {
    bytesOf = (signed) => signed.#bytes
  }

  toJSON(): { hash: string; from: string } {
    return { hash: this.hash, from: this.from }
  }

  toString(): string {
    return this.hash
  }

  [INSPECT_CUSTOM](): string {
    return this.toString()
  }
}

/**
 * The signed transaction as `0x` and hex, for the request body of the
 * broadcast (`eth_sendRawTransaction`).
 *
 * Only the module that broadcasts may call it, and the string must go nowhere
 * but that request body: not a result, an error, a log, a command line or a
 * file. It is not re-exported from `src/core/index.ts`.
 */
export function rawTransactionHex(signed: SignedEvmTransaction): string {
  return `0x${bytesToHex(bytesOf(signed))}`
}

/** The account that signs: wallet `label`, its index in a seed phrase (`null` for a lone key) and the address it must open. */
export type Sender = { label: string; index: number | null; address: string }

/** The 32-byte secret of account `index` of `phrase`; the seed is zeroed. */
function phraseSecret(phrase: string, index: number): Uint8Array {
  const seed = phraseSeed(phrase)
  try {
    const [secret] = evmSecretsOf(seed, [index])
    return secret
  } finally {
    seed.fill(0)
  }
}

/** Signs `unsigned` with `secret` for `sender`, which `secret` must open. */
function signWith(secret: Uint8Array, sender: Sender, unsigned: EvmTransaction): SignedEvmTransaction {
  const address = evmAddress(secret)
  if (address.toLowerCase() !== sender.address.toLowerCase()) {
    throw new ToolError("stale", `Wallet "${sender.label}" no longer opens ${sender.address}; nothing was signed.`)
  }
  const signed = unsigned.signBy(secret)
  if (signed.recoverSender().address.toLowerCase() !== address.toLowerCase()) {
    throw new ToolError("internal_error", `The signature for wallet "${sender.label}" does not recover its address.`)
  }
  return new SignedEvmTransaction(signed.toBytes(), address)
}

/**
 * Signs `request` as `sender`: wallet `label`, account `index` of a seed
 * phrase (0 when `null`) or its lone EVM key. The address is derived again
 * from the key and must be `sender.address`, else the call fails as `stale`
 * and signs nothing; a key of another family, or an account other than #0 of a
 * lone key, is `invalid_argument`, as is a request that cannot be signed (the
 * request is checked before the key is read).
 *
 * Signatures are hedged: the library mixes fresh randomness into the nonce
 * (RFC 6979 plus extra entropy), so two signatures of one request differ and
 * so do their hashes. The hash is that of the bytes returned.
 *
 * Every copy of the secret is zeroed after. The library reads the secret from
 * the bytes and keeps none; the number noble derives from it inside is out of
 * reach to zero. An error raised while the key is held other than a refusal is
 * replaced by a fixed message.
 */
export async function signEvmTransaction(
  sender: Sender,
  request: EvmTransactionRequest,
  runtime: ToolRuntime,
  stateDir: string,
): Promise<SignedEvmTransaction> {
  const unsigned = prepareEvmTransaction(request)
  const { key } = await readWalletKey(sender.label, runtime, stateDir)
  checkKeyFits(key, sender.label, "evm", sender.index)
  return holding(key, sender.label, "signing for", ({ phrase, secret }) => {
    if (phrase !== undefined) {
      const derived = phraseSecret(phrase, sender.index ?? 0)
      try {
        return signWith(derived, sender, unsigned)
      } finally {
        derived.fill(0)
      }
    }
    if (secret === undefined) {
      throw new ToolError("internal_error", `Wallet "${sender.label}" holds no key material.`)
    }
    return signWith(secret, sender, unsigned)
  })
}
