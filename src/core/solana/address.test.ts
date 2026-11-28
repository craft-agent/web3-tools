import { describe, expect, test } from "bun:test"
import { ed25519 } from "@noble/curves/ed25519.js"
import { hexToBytes } from "@noble/curves/utils.js"
import { base58 } from "@scure/base"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { isToolError } from "../errors"
import {
  associatedTokenAddress,
  findProgramAddress,
  isOnCurve,
  metadataAddress,
  parseSolanaAddress,
  solanaAddressBytes,
} from "./address"

/** The vectors below are those of micro-sol-signer's test/basic.test.ts and test/vectors-sol.json (paulmillr/micro-sol-signer). */
const USDT_MINT = "7o36UsWR1JQLpZ9PE2gn9L4SQ69CNNiWAXd4Jt7rqz9Z"
const PYUSD_MINT = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"

function refusal(work: () => unknown): Error {
  try {
    work()
  } catch (error) {
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    return error as Error
  }
  throw new Error("the call did not refuse")
}

describe("parseSolanaAddress", () => {
  test("takes base58 of 32 bytes, and gives its bytes", () => {
    expect(parseSolanaAddress(SOLANA_PROGRAMS.systemProgram, "recipient")).toBe(SOLANA_PROGRAMS.systemProgram)
    expect(solanaAddressBytes(USDT_MINT, "mint")).toEqual(base58.decode(USDT_MINT))
  })

  test("refuses text that is not base58, of another length or not canonical, naming the argument", () => {
    for (const text of ["", "1111", "0OIl", `${USDT_MINT}1`, `1${SOLANA_PROGRAMS.systemProgram}`, "not-base58"]) {
      expect(refusal(() => parseSolanaAddress(text, "recipient")).message).toStartWith('The recipient "')
    }
  })

  test("quotes a value of 50 characters or less, and a longer one by its length alone", () => {
    const fifty = "x".repeat(50)
    expect(refusal(() => parseSolanaAddress(fifty, "mint")).message).toContain(`"${fifty}"`)
    const long = `${fifty}y`
    const message = refusal(() => parseSolanaAddress(long, "mint")).message
    expect(message).toContain("(51 characters)")
    expect(message).not.toContain("xxxxx")
  })
})

describe("isOnCurve", () => {
  test("is true for a keypair's public key and false for a program address", () => {
    expect(isOnCurve(ed25519.getPublicKey(new Uint8Array(32).fill(8)))).toBe(true)
    const pda = base58.decode(findProgramAddress([], SOLANA_PROGRAMS.tokenProgram).address)
    expect(isOnCurve(pda)).toBe(false)
  })

  test("agrees with Solana on the vectors of micro-sol-signer", () => {
    const vectors: [string, boolean][] = [
      ["66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925", false],
      ["2b32db6c2c0a6235fb1397e8225ea85e0f0e6e8c7b126d0016ccbde0e667151e", true],
      ["12771355e46cd47c71ed1721fd5319b383cca3a1f9fce3aa1c8cd3bd37af20d7", false],
      ["fe15c0d3ebe314fad720a08b839a004c2e6386f5aecc19ec74807d1920cb6aeb", false],
      ["376da11fe3ab3d0eaaddb418ccb49b5426d5c2504f526f7766580f6e45984e3b", true],
      ["4391a5c79ffdc79883036503ca551673c09deec28df432a8d88debc7fa2ec91e", true],
    ]
    for (const [hex, expected] of vectors) expect(isOnCurve(hexToBytes(hex))).toBe(expected)
  })

  test("takes a non-canonical y as Solana does, reduced modulo the field", () => {
    // y = 2^255 - 18 is p + 1, which reduces to y = 1: the identity point.
    const bytes = new Uint8Array(32).fill(0xff)
    bytes[0] = 0xee
    bytes[31] = 0x7f
    expect(isOnCurve(bytes)).toBe(true)
  })
})

describe("findProgramAddress", () => {
  test("derives the vector of micro-sol-signer for no seeds", () => {
    const { address, bump } = findProgramAddress([], "BPFLoader1111111111111111111111111111111111")
    expect(address).toBe("EXWkUCz3YJU9TDVk39ogA4TwoVsUi75ZDhH6yT7acPgQ")
    expect(bump).toBeLessThanOrEqual(255)
    expect(isOnCurve(base58.decode(address))).toBe(false)
  })

  test("is deterministic and differs with the seeds and the program", () => {
    const seed = new TextEncoder().encode("vault")
    const first = findProgramAddress([seed], SOLANA_PROGRAMS.tokenProgram)
    expect(findProgramAddress([seed], SOLANA_PROGRAMS.tokenProgram)).toEqual(first)
    expect(findProgramAddress([seed], SOLANA_PROGRAMS.token2022Program).address).not.toBe(first.address)
    expect(findProgramAddress([Uint8Array.of(1)], SOLANA_PROGRAMS.tokenProgram).address).not.toBe(first.address)
  })

  test("takes 15 seeds of 32 bytes, and refuses a 16th, a longer seed and a program that is no address", () => {
    const seed = new Uint8Array(32).fill(1)
    expect(findProgramAddress(Array(15).fill(seed), SOLANA_PROGRAMS.systemProgram).address).toHaveLength(44)
    refusal(() => findProgramAddress(Array(16).fill(seed), SOLANA_PROGRAMS.systemProgram))
    refusal(() => findProgramAddress([new Uint8Array(33)], SOLANA_PROGRAMS.systemProgram))
    refusal(() => findProgramAddress([], "1111"))
  })
})

describe("associatedTokenAddress", () => {
  test("derives the vectors of micro-sol-signer under Token and Token-2022", () => {
    const token = associatedTokenAddress(
      "B8UwBUUnKwCyKuGMbFKWaG7exYdDk2ozZrPg72NyVbfj",
      USDT_MINT,
      SOLANA_PROGRAMS.tokenProgram,
    )
    expect(token).toBe("DShWnroshVbeUp28oopA3Pu7oFPDBtC1DBmPECXXAQ9n")
    const pyusd = [
      ["22Wnk8PwyWZV7BfkZGJEKT9jGGdtvu7xY6EXeRh7zkBa", "5nu6HDY7t1Ds8oPNsArrhb1rzvRqmGubyteyAUncFyNb"],
      ["BNXnu85Kt1VXSYYYNMXtRfRrscyETxcdsEiTLSToQYZa", "8Ycmt6GTtXcmaTXXRZVLATBQHKKFRaFpD6DD4wx81M4"],
    ]
    for (const [owner, expected] of pyusd) {
      expect(associatedTokenAddress(owner, PYUSD_MINT, SOLANA_PROGRAMS.token2022Program)).toBe(expected)
    }
  })

  test("names the argument that is no address", () => {
    expect(refusal(() => associatedTokenAddress("owner", USDT_MINT, SOLANA_PROGRAMS.tokenProgram)).message).toStartWith(
      'The owner "owner"',
    )
    expect(refusal(() => associatedTokenAddress(USDT_MINT, "mint", SOLANA_PROGRAMS.tokenProgram)).message).toStartWith(
      'The mint "mint"',
    )
  })
})

describe("metadataAddress", () => {
  test("is the program address of the Token Metadata seeds, and off the curve", () => {
    const seeds = [
      new TextEncoder().encode("metadata"),
      base58.decode(SOLANA_PROGRAMS.tokenMetadataProgram),
      base58.decode(USDT_MINT),
    ]
    const expected = findProgramAddress(seeds, SOLANA_PROGRAMS.tokenMetadataProgram).address
    expect(metadataAddress(USDT_MINT)).toBe(expected)
    expect(isOnCurve(base58.decode(expected))).toBe(false)
  })

  test("derives the account mainnet holds for USDC, which Token Metadata owns", () => {
    // Read with getAccountInfo on mainnet: 679 bytes, owner metaqbxx…18x1s.
    expect(metadataAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(
      "5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq",
    )
  })
})
