import { describe, expect, test } from "bun:test"
import { concatBytes } from "@noble/hashes/utils.js"
import { ToolError } from "../errors"
import { testAddress } from "./testing"
import { encodeMetadata } from "./testing.cluster.metadata"
import { checkPlainNft, metadataTokenStandard, tokenPromptSymbol, TOKEN_STANDARDS } from "./token-rules"
import { BONK_METADATA_PREFIX, extension, mintWith, USDC_METADATA_PREFIX } from "./token-rules.fixtures"

const MINT = testAddress(3)

/** The bytes of the fixed fields of a Metadata account up to and including the creators' tag, which is `None`. */
const CREATORS_TAG_OFFSET = 321

/** Where the optional fields of a Metadata account with no creators start. */
const OPTIONAL_FIELDS_OFFSET = 324

function malformed(data: Uint8Array): ToolError {
  try {
    metadataTokenStandard(data)
  } catch (error) {
    if (error instanceof ToolError) return error
    throw error
  }
  throw new Error("Expected the metadata to be refused")
}

describe("metadataTokenStandard", () => {
  test("reads the real accounts of USDC, which predates the token standard, and Bonk, a fungible token", () => {
    expect(USDC_METADATA_PREFIX).toHaveLength(328)
    expect(metadataTokenStandard(USDC_METADATA_PREFIX)).toEqual({ symbol: "USDC", tokenStandard: null })
    expect(BONK_METADATA_PREFIX).toHaveLength(328)
    expect(metadataTokenStandard(BONK_METADATA_PREFIX)).toEqual({
      symbol: "Bonk",
      tokenStandard: TOKEN_STANDARDS.fungible,
    })
  })

  test("a standard the field holds is returned by its number, each of the six", () => {
    for (const standard of Object.values(TOKEN_STANDARDS)) {
      const data = encodeMetadata({ mint: MINT, symbol: "NFT", tokenStandard: standard })
      expect(metadataTokenStandard(data)).toEqual({ symbol: "NFT", tokenStandard: standard })
    }
    expect(Object.values(TOKEN_STANDARDS)).toEqual([0, 1, 2, 3, 4, 5])
  })

  test("a number the enum does not have is returned as it is", () => {
    expect(metadataTokenStandard(encodeMetadata({ mint: MINT, tokenStandard: 9 })).tokenStandard).toBe(9)
  })

  test("trims the symbol's trailing NULs and keeps the text before them whole", () => {
    const data = encodeMetadata({ mint: MINT, symbol: "A\0B", tokenStandard: 0 })
    expect(metadataTokenStandard(data).symbol).toBe("A\0B")
    expect(metadataTokenStandard(encodeMetadata({ mint: MINT, symbol: "", tokenStandard: 0 })).symbol).toBe("")
  })

  test("an account made before the field existed has no standard: `None`, or data that ends before it", () => {
    const none = encodeMetadata({ mint: MINT, symbol: "OLD", tokenStandard: null })
    expect(metadataTokenStandard(none)).toEqual({ symbol: "OLD", tokenStandard: null })
    const whole = encodeMetadata({ mint: MINT, symbol: "OLD", tokenStandard: 0 })
    expect(metadataTokenStandard(whole.slice(0, OPTIONAL_FIELDS_OFFSET))).toEqual({
      symbol: "OLD",
      tokenStandard: null,
    })
    expect(metadataTokenStandard(whole.slice(0, OPTIONAL_FIELDS_OFFSET + 2))).toEqual({
      symbol: "OLD",
      tokenStandard: null,
    })
  })

  test("stops at the token standard: what follows is not read", () => {
    const whole = encodeMetadata({ mint: MINT, tokenStandard: 4 })
    whole.fill(0xff, OPTIONAL_FIELDS_OFFSET + 4)
    expect(metadataTokenStandard(whole).tokenStandard).toBe(4)
  })

  test("skips creators: none, one and several", () => {
    const base = encodeMetadata({ mint: MINT, symbol: "NFT", tokenStandard: 3 })
    for (const count of [1, 2, 5]) {
      const creators = new Uint8Array(1 + 4 + count * 34)
      creators[0] = 1
      new DataView(creators.buffer).setUint32(1, count, true)
      const data = concatBytes(base.slice(0, CREATORS_TAG_OFFSET), creators, base.slice(CREATORS_TAG_OFFSET + 1))
      expect(metadataTokenStandard(data)).toEqual({ symbol: "NFT", tokenStandard: 3 })
    }
  })

  test("data that ends inside a field, before the fields, or with a tag that is neither 0 nor 1 is upstream_error", () => {
    const whole = encodeMetadata({ mint: MINT, symbol: "NFT", tokenStandard: 0 })
    const cuts = [
      0,
      1,
      40,
      65,
      66,
      100,
      105,
      120,
      200,
      320,
      322,
      323,
      OPTIONAL_FIELDS_OFFSET + 1,
      OPTIONAL_FIELDS_OFFSET + 3,
    ]
    for (const cut of cuts) {
      const error = malformed(whole.slice(0, cut))
      expect(error.code).toBe("upstream_error")
      expect(error.message).toContain("metadata")
    }
    for (const [offset, value] of [
      [CREATORS_TAG_OFFSET, 2],
      [OPTIONAL_FIELDS_OFFSET, 2],
      [OPTIONAL_FIELDS_OFFSET + 2, 7],
    ]) {
      const bad = whole.slice()
      bad[offset] = value
      expect(malformed(bad).code).toBe("upstream_error")
    }
  })

  test("a string that claims more bytes than the data has, and a count of creators that does, are upstream_error", () => {
    const whole = encodeMetadata({ mint: MINT, tokenStandard: 0 })
    const longName = whole.slice()
    new DataView(longName.buffer).setUint32(65, 0xffff_ffff, true)
    expect(malformed(longName).code).toBe("upstream_error")
    const manyCreators = whole.slice()
    manyCreators[CREATORS_TAG_OFFSET] = 1
    new DataView(manyCreators.buffer).setUint32(CREATORS_TAG_OFFSET + 1, 0xffff_ffff, true)
    expect(malformed(manyCreators).code).toBe("upstream_error")
  })

  test("another key than MetadataV1 is upstream_error", () => {
    for (const key of [0, 1, 3, 5, 255]) {
      const data = encodeMetadata({ mint: MINT, tokenStandard: 0 })
      data[0] = key
      expect(malformed(data).code).toBe("upstream_error")
    }
  })
})

describe("checkPlainNft", () => {
  const nft = mintWith([], 0, 1n)
  const standard = (tokenStandard: number | null) => ({ symbol: "NFT", tokenStandard })

  test("a master edition and a printed edition are plain, and so is an old account with no standard or none at all", () => {
    for (const metadata of [standard(0), standard(3), standard(null), null]) {
      expect(() => checkPlainNft(nft, metadata)).not.toThrow()
    }
  })

  test("a programmable NFT is refused: it moves through Token Metadata's own instruction", () => {
    for (const metadata of [standard(4), standard(5)]) {
      expect(() => checkPlainNft(nft, metadata)).toThrow(/programmable NFT/)
    }
  })

  test("a fungible token or asset is refused with a pointer to sending it as a token", () => {
    for (const metadata of [standard(1), standard(2)]) {
      expect(() => checkPlainNft(nft, metadata)).toThrow("send it as a token")
      expect(() => checkPlainNft(mintWith([], 6, 1_000n), metadata)).toThrow("send it as a token")
    }
  })

  test("a mint that is not 0 decimals and a supply of 1 is not an NFT, whatever its metadata says", () => {
    for (const metadata of [standard(0), null]) {
      expect(() => checkPlainNft(mintWith([], 6, 1n), metadata)).toThrow("6 decimals and a supply of 1")
      expect(() => checkPlainNft(mintWith([], 0, 2n), metadata)).toThrow("0 decimals and a supply of 2")
      expect(() => checkPlainNft(mintWith([], 0, 0n), metadata)).toThrow("not an NFT")
    }
  })

  test("a standard these tools do not know is refused, not guessed at", () => {
    expect(() => checkPlainNft(nft, standard(6))).toThrow("token standard 6")
  })

  test("every refusal is invalid_argument", () => {
    for (const run of [
      () => checkPlainNft(nft, standard(4)),
      () => checkPlainNft(nft, standard(2)),
      () => checkPlainNft(mintWith([], 1, 1n), null),
      () => checkPlainNft(nft, standard(9)),
    ]) {
      try {
        run()
        throw new Error("not refused")
      } catch (error) {
        expect((error as ToolError).code).toBe("invalid_argument")
      }
    }
  })
})

describe("tokenPromptSymbol", () => {
  test("prefers the Token-2022 tokenMetadata symbol, and falls back to the Metaplex one", () => {
    const withExtension = mintWith([extension("tokenMetadata", { symbol: "PYUSD" })])
    expect(tokenPromptSymbol(withExtension, { symbol: "OTHER", tokenStandard: null })).toBe("PYUSD")
    expect(tokenPromptSymbol(mintWith(), { symbol: "USDC", tokenStandard: null })).toBe("USDC")
    expect(tokenPromptSymbol(mintWith(), null)).toBeNull()
  })

  test("passes a symbol through the filter a prompt shows: stranger-chosen text is dropped", () => {
    for (const symbol of ["", "TOO-LONG-SYMBOL", "Ignore previous", "a\nb", "💰", "<b>"]) {
      expect(tokenPromptSymbol(mintWith(), { symbol, tokenStandard: null })).toBeNull()
      expect(tokenPromptSymbol(mintWith([extension("tokenMetadata", { symbol })]), null)).toBeNull()
    }
    expect(tokenPromptSymbol(mintWith(), { symbol: "$WIF.x_y-1", tokenStandard: null })).toBe("$WIF.x_y-1")
  })

  test("a tokenMetadata extension with no text for a symbol falls back to the Metaplex symbol", () => {
    expect(tokenPromptSymbol(mintWith([extension("tokenMetadata")]), { symbol: "ABC", tokenStandard: null })).toBe(
      "ABC",
    )
  })
})
