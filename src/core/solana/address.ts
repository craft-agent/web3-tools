import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { base58 } from "@scure/base"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { ToolError } from "../errors"

/** The byte length of a Solana address, a public key. */
export const SOLANA_ADDRESS_BYTES = 32

/** The longest text an error quotes back; a longer one is reported by its length. */
const MAX_QUOTED_LENGTH = 50

/** The most seeds a program address takes, the bump seed included. */
const MAX_SEEDS = 16

/** The longest seed in bytes. */
const MAX_SEED_BYTES = 32

/** The highest bump seed; the search counts down from it. */
const MAX_BUMP = 255

/** The suffix Solana hashes after the program id to keep program addresses apart from keys. */
const PDA_MARKER = utf8ToBytes("ProgramDerivedAddress")

/** The seed of a metadata account, before the Token Metadata program and the mint. */
const METADATA_SEED = utf8ToBytes("metadata")

function invalid(text: string, name: string): ToolError {
  const subject = text.length > MAX_QUOTED_LENGTH ? `(${text.length} characters)` : `"${text}"`
  return new ToolError("invalid_argument", `The ${name} ${subject} is not a Solana address: base58 text of 32 bytes.`)
}

/**
 * The 32 bytes of the Solana address `text`, which must be base58 of exactly
 * 32 bytes in its canonical form; else `invalid_argument` naming `name` and
 * quoting `text` only up to 50 characters.
 */
export function solanaAddressBytes(text: string, name: string): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = base58.decode(text)
  } catch {
    throw invalid(text, name)
  }
  if (bytes.length !== SOLANA_ADDRESS_BYTES || base58.encode(bytes) !== text) throw invalid(text, name)
  return bytes
}

/** `text` when it is a Solana address (base58 of 32 bytes, canonical); else `invalid_argument` naming `name`. */
export function parseSolanaAddress(text: string, name: string): string {
  solanaAddressBytes(text, name)
  return text
}

/**
 * Whether `bytes32` is a valid ed25519 point, as Solana decides it: a
 * non-canonical `y` is reduced, as curve25519-dalek does. A wallet's public
 * key is on the curve; a program address never is.
 */
export function isOnCurve(bytes32: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes32, true)
    return true
  } catch {
    return false
  }
}

/** The program address of `seeds` under `programId` and the bump seed that made it. */
export type ProgramAddress = { address: string; bump: number }

/**
 * Solana's search for a program derived address: the first bump seed from 255
 * down to 0 for which `sha256(seeds ‖ bump ‖ programId ‖ "ProgramDerivedAddress")`
 * is off the curve. At most 15 seeds of 32 bytes each, since the bump is the
 * sixteenth.
 */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): ProgramAddress {
  if (seeds.length >= MAX_SEEDS) {
    throw new ToolError("invalid_argument", `A program address takes at most ${MAX_SEEDS - 1} seeds besides its bump.`)
  }
  if (seeds.some((seed) => seed.length > MAX_SEED_BYTES)) {
    throw new ToolError("invalid_argument", `A seed of a program address is at most ${MAX_SEED_BYTES} bytes.`)
  }
  const program = solanaAddressBytes(programId, "program id")
  for (let bump = MAX_BUMP; bump >= 0; bump--) {
    const hash = sha256(concatBytes(...seeds, Uint8Array.of(bump), program, PDA_MARKER))
    if (!isOnCurve(hash)) return { address: base58.encode(hash), bump }
  }
  throw new ToolError("internal_error", "No bump seed gave a program address off the curve.")
}

/** The associated token account of `owner` for `mint` under `tokenProgram`: seeds `[owner, tokenProgram, mint]` under the Associated Token Account program. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  const seeds = [
    solanaAddressBytes(owner, "owner"),
    solanaAddressBytes(tokenProgram, "token program"),
    solanaAddressBytes(mint, "mint"),
  ]
  return findProgramAddress(seeds, SOLANA_PROGRAMS.associatedTokenProgram).address
}

/** The Metaplex metadata account of `mint`: seeds `["metadata", Token Metadata, mint]` under Token Metadata. */
export function metadataAddress(mint: string): string {
  const seeds = [METADATA_SEED, base58.decode(SOLANA_PROGRAMS.tokenMetadataProgram), solanaAddressBytes(mint, "mint")]
  return findProgramAddress(seeds, SOLANA_PROGRAMS.tokenMetadataProgram).address
}
