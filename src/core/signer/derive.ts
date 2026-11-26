import { ed25519 } from "@noble/curves/ed25519.js"
import { secp256k1 } from "@noble/curves/secp256k1.js"
import { bytesToHex } from "@noble/curves/utils.js"
import { hmac } from "@noble/hashes/hmac.js"
import { sha512 } from "@noble/hashes/sha2.js"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { base58 } from "@scure/base"
import { HARDENED_OFFSET, HDKey } from "@scure/bip32"
import { mnemonicToSeedSync } from "@scure/bip39"
import { ToolError } from "../errors"
import { KEY_BYTES } from "./keys"

/** The highest account index of a seed phrase that is derived, listed or addressed. */
export const MAX_ACCOUNT_INDEX = 100

/** The HMAC key of SLIP-0010's ed25519 master node. */
const ED25519_SEED_KEY = new TextEncoder().encode("ed25519 seed")

/** The byte length of an uncompressed secp256k1 public key: `0x04`, then X and Y. */
const UNCOMPRESSED_PUBLIC_KEY_BYTES = 65

/** The length in bytes of an EVM address. */
const ADDRESS_BYTES = 20

function hardened(index: number): number {
  return index + HARDENED_OFFSET
}

/** `m/44'/60'/0'/0`, the parent of MetaMask's accounts. */
const EVM_PARENT_PATH = [hardened(44), hardened(60), hardened(0), 0]

/** `m/44'/501'/<index>'/0'` without the account index, which goes third; Phantom's accounts. */
const SOLANA_PATH_PREFIX = [44, 501]

/** The 20 address bytes as `0x` and 40 hex digits, with EIP-55 capitals. */
export function toChecksumAddress(address20: Uint8Array): string {
  if (address20.length !== ADDRESS_BYTES) {
    throw new ToolError("internal_error", `An EVM address is ${ADDRESS_BYTES} bytes, not ${address20.length}.`)
  }
  const lower = bytesToHex(address20)
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)))
  let checksummed = "0x"
  for (let position = 0; position < lower.length; position++) {
    // A hex digit is capitalized when the matching nibble of the hash is 8 or more.
    checksummed += Number.parseInt(hash[position], 16) >= 8 ? lower[position].toUpperCase() : lower[position]
  }
  return checksummed
}

/** The EIP-55 address of the EVM secret `secret32`: the last 20 bytes of the Keccak-256 of its public key. */
export function evmAddress(secret32: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(secret32, false)
  try {
    if (publicKey.length !== UNCOMPRESSED_PUBLIC_KEY_BYTES) {
      throw new ToolError("internal_error", "An uncompressed secp256k1 public key is 65 bytes.")
    }
    return toChecksumAddress(keccak_256(publicKey.subarray(1)).subarray(-ADDRESS_BYTES))
  } finally {
    publicKey.fill(0)
  }
}

/** The Solana address of the ed25519 seed `seed32`: its public key in base58. */
export function solanaAddress(seed32: Uint8Array): string {
  return base58.encode(ed25519.getPublicKey(seed32))
}

/** The seed of a BIP-39 phrase in its normal form, with no passphrase. */
export function phraseSeed(phrase: string): Uint8Array {
  return mnemonicToSeedSync(phrase, "")
}

/**
 * SLIP-0010 for ed25519: the 32-byte secret at the hardened path of `indexes`
 * under `seed`, each given unhardened (0 up to 2^31 - 1). No indexes give the
 * master node. Every intermediate node is zeroed.
 */
export function slip10Ed25519(seed: Uint8Array, indexes: readonly number[]): Uint8Array {
  let node = hmac(sha512, ED25519_SEED_KEY, seed)
  try {
    for (const index of indexes) {
      if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
        throw new ToolError("internal_error", "A derivation index is a whole number from 0 up to 2^31 - 1.")
      }
      const data = new Uint8Array(1 + KEY_BYTES + 4)
      try {
        data.set(node.subarray(0, KEY_BYTES), 1)
        new DataView(data.buffer).setUint32(1 + KEY_BYTES, hardened(index))
        const next = hmac(sha512, node.subarray(KEY_BYTES), data)
        node.fill(0)
        node = next
      } finally {
        data.fill(0)
      }
    }
    return node.slice(0, KEY_BYTES)
  } finally {
    node.fill(0)
  }
}

/** The key of `m/44'/60'/0'/0`, derived from the master key one step at a time so none is left holding a secret. */
function evmParent(seed: Uint8Array): HDKey {
  let node = HDKey.fromMasterSeed(seed)
  try {
    for (const index of EVM_PARENT_PATH) {
      const next = node.deriveChild(index)
      node.wipePrivateData()
      node = next
    }
    return node
  } catch (error) {
    node.wipePrivateData()
    throw error
  }
}

/** The 32-byte secrets of `m/44'/60'/0'/0/<index>` for each of `indexes`; the parent is derived once. */
export function evmSecretsOf(seed: Uint8Array, indexes: readonly number[]): Uint8Array[] {
  const parent = evmParent(seed)
  const secrets: Uint8Array[] = []
  try {
    for (const index of indexes) {
      const child = parent.deriveChild(index)
      const secret = child.privateKey
      child.wipePrivateData()
      if (secret === null) throw new ToolError("internal_error", "A derived EVM key has no secret.")
      secrets.push(secret)
    }
    return secrets
  } catch (error) {
    for (const secret of secrets) secret.fill(0)
    throw error
  } finally {
    parent.wipePrivateData()
  }
}

/** The 32-byte seed of the Solana account `m/44'/501'/<index>'/0'`. */
export function solanaSeedOf(seed: Uint8Array, index: number): Uint8Array {
  return slip10Ed25519(seed, [...SOLANA_PATH_PREFIX, index, 0])
}
