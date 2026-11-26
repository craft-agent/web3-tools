import { ed25519 } from "@noble/curves/ed25519.js"
import { secp256k1 } from "@noble/curves/secp256k1.js"
import { equalBytes, hexToBytes } from "@noble/curves/utils.js"
import { base58 } from "@scure/base"
import { validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { ToolError } from "../errors"

/** What a wallet's key is: a seed phrase, an EVM private key or a Solana keypair. */
export type KeyKind = "phrase" | "evm" | "solana"

/** A chain family a key can sign on. */
export type Family = "evm" | "solana"

/** The word counts of a BIP-39 phrase. */
const PHRASE_WORD_COUNTS = [12, 15, 18, 21, 24]

/** The byte length of an EVM secret and of a Solana seed or public key. */
const KEY_BYTES = 32

/** The byte length of a Solana keypair: the seed, then the public key. */
const KEYPAIR_BYTES = 64

/** 64 hex digits, `0x` before them or not. */
const EVM_KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/

/** The `util.inspect` hook of Node and Bun. */
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom")

/** The key material of a wallet key: the phrase, or the secret bytes of an EVM key or a Solana keypair. */
type KeyMaterial = { phrase?: string; secret?: Uint8Array }

let materialOf: (key: WalletKey) => KeyMaterial

/**
 * A wallet's key. Its material lives in private fields and never reaches a
 * string: `JSON.stringify`, `String`, a template and `util.inspect` all give the
 * kind alone.
 */
export class WalletKey {
  readonly kind: KeyKind
  /** The word count of a phrase. */
  declare readonly words?: number
  readonly #phrase: string | undefined
  readonly #secret: Uint8Array | undefined

  /**
   * Takes the material over without copying it: a phrase in its normal form
   * (NFKD, lowercase, single spaces) for `phrase`, the 32-byte secret for
   * `evm`, the 64-byte keypair for `solana`.
   */
  constructor(kind: KeyKind, material: KeyMaterial) {
    const { phrase, secret } = material
    const fits =
      kind === "phrase"
        ? phrase !== undefined && secret === undefined
        : phrase === undefined && secret?.length === (kind === "evm" ? KEY_BYTES : KEYPAIR_BYTES)
    if (!fits) {
      throw new ToolError("internal_error", `A ${kind} wallet key was built from material of another kind.`)
    }
    this.kind = kind
    if (phrase !== undefined) this.words = phrase.split(" ").length
    this.#phrase = phrase
    this.#secret = secret
  }

  static {
    materialOf = (key) => ({
      phrase: key.#phrase,
      secret: key.#secret === undefined ? undefined : new Uint8Array(key.#secret),
    })
  }

  /** The families this key signs on: a phrase opens both, a key its own. */
  families(): Family[] {
    return this.kind === "phrase" ? ["evm", "solana"] : [this.kind]
  }

  toJSON(): { kind: KeyKind; words?: number } {
    return this.words === undefined ? { kind: this.kind } : { kind: this.kind, words: this.words }
  }

  toString(): string {
    return `[wallet key: ${this.kind}]`
  }

  [INSPECT_CUSTOM](): string {
    return this.toString()
  }
}

/**
 * The material of `key`, as copies the caller may zero.
 *
 * Only `src/core/signer/` may call it; it is not re-exported from
 * `src/core/index.ts`, so no tool sees a key's bytes.
 */
export function keyMaterial(key: WalletKey): KeyMaterial {
  return materialOf(key)
}

function refuse(label: string, what: string): ToolError {
  return new ToolError("unauthenticated", `The key of wallet "${label}" ${what}`)
}

function unknownForm(label: string): ToolError {
  return refuse(label, "is not a seed phrase, an EVM private key or a Solana keypair.")
}

/** The bytes of a JSON array of 64 integers 0 to 255, or undefined for anything else. */
function jsonKeypair(text: string): Uint8Array | undefined {
  let values: unknown
  try {
    values = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!Array.isArray(values) || values.length !== KEYPAIR_BYTES) return undefined
  if (!values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) return undefined
  const bytes = Uint8Array.from(values as number[])
  values.fill(0)
  return bytes
}

function base58Keypair(text: string): Uint8Array | undefined {
  let bytes: Uint8Array
  try {
    bytes = base58.decode(text)
  } catch {
    return undefined
  }
  if (bytes.length === KEYPAIR_BYTES) return bytes
  bytes.fill(0)
  return undefined
}

function solanaKey(keypair: Uint8Array, label: string): WalletKey {
  const publicKey = ed25519.getPublicKey(keypair.subarray(0, KEY_BYTES))
  if (!equalBytes(publicKey, keypair.subarray(KEY_BYTES))) {
    keypair.fill(0)
    throw refuse(label, "is a Solana keypair whose public half does not match its secret.")
  }
  return new WalletKey("solana", { secret: keypair })
}

function evmKey(hex: string, label: string): WalletKey {
  const secret = hexToBytes(hex.startsWith("0x") ? hex.slice(2) : hex)
  if (!secp256k1.utils.isValidSecretKey(secret)) {
    secret.fill(0)
    throw refuse(label, "is not a valid EVM private key.")
  }
  return new WalletKey("evm", { secret })
}

function phraseKey(text: string, label: string): WalletKey {
  const words = text.normalize("NFKD").toLowerCase().split(/\s+/).filter(Boolean)
  if (!PHRASE_WORD_COUNTS.includes(words.length)) {
    throw refuse(label, `is a phrase of ${words.length} words; a BIP-39 phrase has 12, 15, 18, 21 or 24.`)
  }
  const phrase = words.join(" ")
  if (!validateMnemonic(phrase, wordlist)) {
    throw refuse(
      label,
      "is not a valid BIP-39 phrase: a word is not in the English list or its checksum does not match.",
    )
  }
  return new WalletKey("phrase", { phrase })
}

/**
 * Reads the text of a wallet's key: a BIP-39 phrase (12, 15, 18, 21 or 24
 * English words), 64 hex digits (with or without `0x`) or a Solana keypair
 * (a JSON array of 64 numbers, or 64 bytes in base58).
 *
 * Every refusal is `unauthenticated` and names the label alone; nothing of
 * `text` reaches a message, and no refusal carries a cause.
 */
export function parseKey(text: string, label: string): WalletKey {
  const trimmed = text.trim()
  if (trimmed === "") throw refuse(label, "is empty.")

  if (trimmed.startsWith("[")) {
    const keypair = jsonKeypair(trimmed)
    if (keypair === undefined) throw unknownForm(label)
    return solanaKey(keypair, label)
  }
  if (EVM_KEY_PATTERN.test(trimmed)) return evmKey(trimmed, label)
  if (/\s/.test(trimmed)) return phraseKey(trimmed, label)

  const keypair = base58Keypair(trimmed)
  if (keypair === undefined) throw unknownForm(label)
  return solanaKey(keypair, label)
}
