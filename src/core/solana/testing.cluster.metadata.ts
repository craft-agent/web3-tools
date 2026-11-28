import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { base58 } from "@scure/base"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { METADATA_V1_KEY } from "./token-rules"

/** What a Token Metadata `Metadata` account is made of, as far as the fake and the tests set it. */
export type MetadataInit = {
  mint: string
  /** The token standard's number, or `null` for an account made before the field existed. */
  tokenStandard: number | null
  /** Defaults to the System program's address. */
  updateAuthority?: string
  name?: string
  symbol?: string
  uri?: string
  sellerFeeBasisPoints?: number
}

/** The bytes of a Metadata account: the program allocates them whatever the strings hold. */
export const METADATA_ACCOUNT_BYTES = 679

/** The length a name, a symbol and a URI are padded to with NULs, as the program does. */
const NAME_BYTES = 32
const SYMBOL_BYTES = 10
const URI_BYTES = 200

const EDITION_NONCE = 255

/** A Borsh string of `text` padded with NULs to `length` bytes. */
function paddedString(text: string, length: number): Uint8Array {
  const bytes = utf8ToBytes(text)
  const padded = new Uint8Array(Math.max(length, bytes.length))
  padded.set(bytes)
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, padded.length, true)
  return concatBytes(size, padded)
}

/**
 * A Token Metadata `Metadata` account as the program lays it out (Borsh): the key, update authority, mint, name,
 * symbol and URI padded with NULs, seller fee, no creators, primary sale not happened, mutable, an edition nonce and
 * the token standard, then zeros up to 679 bytes. The fields after the token standard (collection, uses, collection
 * details, programmable config) are not written.
 */
export function encodeMetadata(init: MetadataInit): Uint8Array {
  const fee = new Uint8Array(2)
  new DataView(fee.buffer).setUint16(0, init.sellerFeeBasisPoints ?? 0, true)
  const fields = concatBytes(
    Uint8Array.of(METADATA_V1_KEY),
    base58.decode(init.updateAuthority ?? SOLANA_PROGRAMS.systemProgram),
    base58.decode(init.mint),
    paddedString(init.name ?? "", NAME_BYTES),
    paddedString(init.symbol ?? "", SYMBOL_BYTES),
    paddedString(init.uri ?? "", URI_BYTES),
    fee,
    Uint8Array.of(0),
    Uint8Array.of(0, 1),
    Uint8Array.of(1, EDITION_NONCE),
    init.tokenStandard === null ? Uint8Array.of(0) : Uint8Array.of(1, init.tokenStandard),
  )
  const bytes = new Uint8Array(Math.max(METADATA_ACCOUNT_BYTES, fields.length))
  bytes.set(fields)
  return bytes
}
