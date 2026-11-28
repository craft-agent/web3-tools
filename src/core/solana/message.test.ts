import { describe, expect, test } from "bun:test"
import { hexToBytes } from "@noble/curves/utils.js"
import { base58, base64 } from "@scure/base"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { isToolError } from "../errors"
import type { ErrorCode } from "../errors"
import type { SolanaInstruction } from "./instructions"
import {
  compactU16,
  compileLegacyMessage,
  decodeCompactU16,
  decodeLegacyMessage,
  MAX_TRANSACTION_BYTES,
  serializeTransaction,
  transactionBase64,
  unsignedTransactionBase64,
} from "./message"
import type { SolanaMessage } from "./message"
import { testAddress, TRANSFER_MESSAGE, TRANSFER_VECTOR } from "./testing"

const BLOCKHASH = TRANSFER_VECTOR.blockhash

/** An instruction of `program` over `accounts`, each `[address, signer, writable]`. */
function instruction(
  program: string,
  accounts: [string, boolean, boolean][],
  data = new Uint8Array(),
): SolanaInstruction {
  return {
    programId: program,
    accounts: accounts.map(([address, signer, writable]) => ({ address, signer, writable })),
    data,
  }
}

function refusal(work: () => unknown, code: ErrorCode = "invalid_argument"): Error {
  try {
    work()
  } catch (error) {
    expect(isToolError(error) && error.code).toBe(code)
    return error as Error
  }
  throw new Error("the call did not refuse")
}

/** The account keys of a compiled message, after its 3-byte header and a one-byte count. */
function keysOf(message: Uint8Array): string[] {
  return Array.from({ length: message[3] }, (_, index) => base58.encode(message.slice(4 + 32 * index, 36 + 32 * index)))
}

describe("compactU16", () => {
  test("encodes the bounds, and decodes what it encodes", () => {
    const vectors: [number, string][] = [
      [0, "00"],
      [5, "05"],
      [127, "7f"],
      [128, "8001"],
      [255, "ff01"],
      [256, "8002"],
      [16383, "ff7f"],
      [16384, "808001"],
      [32767, "ffff01"],
      [65535, "ffff03"],
    ]
    for (const [value, hex] of vectors) {
      expect(compactU16(value)).toEqual(hexToBytes(hex))
      expect(decodeCompactU16(hexToBytes(hex))).toEqual({ value, length: hex.length / 2 })
    }
  })

  test("decodes at an offset, past the bytes the count leaves", () => {
    expect(decodeCompactU16(Uint8Array.of(9, 0x80, 0x01, 7), 1)).toEqual({ value: 128, length: 2 })
  })

  test("refuses a value out of range", () => {
    for (const value of [-1, 65536, 1.5, Number.NaN]) refusal(() => compactU16(value))
  })

  test("refuses a decoding that is cut short, longer than the shortest form or over 65535", () => {
    for (const hex of ["", "80", "8000", "808000", "ffff04", "ffffff", "80808001"]) {
      refusal(() => decodeCompactU16(hexToBytes(hex)))
    }
  })
})

describe("compileLegacyMessage", () => {
  test("reproduces the message of micro-sol-signer's test/basic.test.ts", () => {
    const payer = "tkA8v2UimqAMydd96Bt7eCNRMBj3Y5v2f5ppfSPevGi"
    const other = "8WYTyUSQnjur5LEK2M8Z88KefbmC7BbpyKwCJaKyU1hC"
    const program = "3sNzSjg8pmvbcRb8wgL6SvRqNLbkLha38hRUEWKVdC1M"
    const message = {
      feePayer: payer,
      recentBlockhash: "J2BjKU6L83eehHVgoze6uTXGCBu6nbxsqEro9QvWpU52",
      instructions: [
        instruction(program, [
          [other, true, true],
          [payer, true, true],
        ]),
      ],
    }
    expect(compileLegacyMessage(message)).toEqual(
      hexToBytes(
        "020001030d416b6d000c3755a8f26d60055a55d9c1f9e1c7eb69a26a0f607ae9021181cb6f933ac79a156bbc4c067fc695e1a4711379d4567166f3479dffb1c2258eebd32a9f4768afe2d0e672096a346f64f32736415326a6352a37596e3ceb8e51d200fce463fd6b571c62c287dc02d1e1a47f6eaa4c5479c779c2ab05d79a856d65bd010202010000",
      ),
    )
  })

  test("reproduces the unsigned transfer of micro-sol-signer's transaction test, byte for byte", () => {
    const message = compileLegacyMessage(TRANSFER_MESSAGE)
    expect(unsignedTransactionBase64(message)).toBe(TRANSFER_VECTOR.unsignedBase64)
    expect(message).toEqual(base64.decode(TRANSFER_VECTOR.unsignedBase64).slice(1 + 64))
  })

  test("orders the accounts fee payer first, then by group and first appearance, merging permissions", () => {
    const [fee, a, b, c, d, e] = [1, 2, 3, 4, 5, 6].map(testAddress)
    const [p1, p2] = [SOLANA_PROGRAMS.tokenProgram, SOLANA_PROGRAMS.systemProgram]
    const message = compileLegacyMessage({
      feePayer: fee,
      recentBlockhash: BLOCKHASH,
      instructions: [
        instruction(p1, [
          [a, false, false],
          [b, false, true],
          [c, true, false],
          [d, true, true],
        ]),
        instruction(p2, [
          [a, false, true],
          [e, false, false],
          [c, true, false],
        ]),
      ],
    })
    // a is writable by its second use; fee, d and c sign, c only to read; p1, p2 and e are read only.
    expect(keysOf(message)).toEqual([fee, d, c, a, b, p1, p2, e])
    expect(Array.from(message.slice(0, 3))).toEqual([3, 1, 3])
    expect(decodeLegacyMessage(message).instructions.map((one) => one.accounts.map((meta) => meta.address))).toEqual([
      [a, b, c, d],
      [a, e, c],
    ])
  })

  test("makes a fee payer no instruction names, or names as a reader, a signer and writer first", () => {
    const [fee, other] = [1, 2].map(testAddress)
    const bare = compileLegacyMessage({
      feePayer: fee,
      recentBlockhash: BLOCKHASH,
      instructions: [instruction(SOLANA_PROGRAMS.systemProgram, [[other, false, true]])],
    })
    expect(keysOf(bare)).toEqual([fee, other, SOLANA_PROGRAMS.systemProgram])
    expect(Array.from(bare.slice(0, 3))).toEqual([1, 0, 1])

    const reader = compileLegacyMessage({
      feePayer: fee,
      recentBlockhash: BLOCKHASH,
      instructions: [
        instruction(SOLANA_PROGRAMS.systemProgram, [
          [other, true, true],
          [fee, false, false],
        ]),
      ],
    })
    expect(keysOf(reader)).toEqual([fee, other, SOLANA_PROGRAMS.systemProgram])
    expect(Array.from(reader.slice(0, 3))).toEqual([2, 0, 1])
  })

  test("takes no instruction at all", () => {
    const message = compileLegacyMessage({
      feePayer: TRANSFER_VECTOR.sender,
      recentBlockhash: BLOCKHASH,
      instructions: [],
    })
    expect(decodeLegacyMessage(message).instructions).toEqual([])
  })

  test("refuses an address or a blockhash that is not base58 of 32 bytes", () => {
    const base = TRANSFER_MESSAGE
    refusal(() => compileLegacyMessage({ ...base, feePayer: "nope" }))
    refusal(() => compileLegacyMessage({ ...base, recentBlockhash: "1111" }))
    refusal(() => compileLegacyMessage({ ...base, recentBlockhash: "0OIl" }))
    refusal(() => compileLegacyMessage({ ...base, instructions: [instruction("nope", [])] }))
    refusal(() =>
      compileLegacyMessage({
        ...base,
        instructions: [instruction(SOLANA_PROGRAMS.systemProgram, [["nope", false, false]])],
      }),
    )
  })

  test("refuses more than 256 accounts, and 256 for their size", () => {
    const build = (count: number) =>
      compileLegacyMessage({
        feePayer: testAddress(1),
        recentBlockhash: BLOCKHASH,
        instructions: [
          instruction(
            SOLANA_PROGRAMS.systemProgram,
            Array.from({ length: count }, (_, index) => [testAddress(index + 100), false, false]),
          ),
        ],
      })
    // The fee payer and the program take two places.
    expect(refusal(() => build(255)).message).toContain("at most 256 accounts")
    expect(refusal(() => build(254)).message).toContain("bytes once signed")
  })

  test("takes a transaction of 1232 bytes once signed and refuses one byte more", () => {
    const withData = (length: number): SolanaMessage => ({
      feePayer: TRANSFER_VECTOR.sender,
      recentBlockhash: BLOCKHASH,
      instructions: [instruction(SOLANA_PROGRAMS.systemProgram, [], new Uint8Array(length))],
    })
    // One signature takes 1 + 64 bytes; data of 128 bytes or more has a two-byte length.
    const room = MAX_TRANSACTION_BYTES - 65 - compileLegacyMessage(withData(0)).length - 1
    expect(65 + compileLegacyMessage(withData(room)).length).toBe(MAX_TRANSACTION_BYTES)
    refusal(() => compileLegacyMessage(withData(room + 1)))
  })
})

describe("decodeLegacyMessage", () => {
  test("gives back the message of a transfer", () => {
    expect(decodeLegacyMessage(compileLegacyMessage(TRANSFER_MESSAGE))).toEqual(TRANSFER_MESSAGE)
  })

  test("compiles again to the same bytes when permissions were merged", () => {
    const [fee, a, b] = [1, 2, 3].map(testAddress)
    const message = compileLegacyMessage({
      feePayer: fee,
      recentBlockhash: BLOCKHASH,
      instructions: [
        instruction(
          SOLANA_PROGRAMS.tokenProgram,
          [
            [a, false, false],
            [fee, true, false],
          ],
          Uint8Array.of(5),
        ),
        instruction(
          SOLANA_PROGRAMS.systemProgram,
          [
            [a, false, true],
            [b, false, false],
          ],
          Uint8Array.of(1, 2, 3),
        ),
        instruction(SOLANA_PROGRAMS.computeBudgetProgram, []),
      ],
    })
    expect(compileLegacyMessage(decodeLegacyMessage(message))).toEqual(message)
  })

  test("refuses bytes that are no legacy message", () => {
    const message = compileLegacyMessage(TRANSFER_MESSAGE)
    refusal(() => decodeLegacyMessage(new Uint8Array()))
    refusal(() => decodeLegacyMessage(message.slice(0, -1)))
    refusal(() => decodeLegacyMessage(Uint8Array.of(...message, 0)))
    for (const [position, value] of [
      [0, 0],
      [0, 4],
      [1, 1],
      [2, 4],
    ]) {
      const header = Uint8Array.from(message)
      header[position] = value
      refusal(() => decodeLegacyMessage(header), "invalid_argument")
    }
    for (const fromEnd of [14, 17]) {
      const index = Uint8Array.from(message)
      index[message.length - fromEnd] = 9
      refusal(() => decodeLegacyMessage(index))
    }
  })
})

describe("serializeTransaction", () => {
  const message = compileLegacyMessage(TRANSFER_MESSAGE)

  test("is the signature count, the signatures and the message", () => {
    const signature = new Uint8Array(64).fill(3)
    expect(serializeTransaction([signature], message)).toEqual(Uint8Array.of(1, ...signature, ...message))
    expect(base64.decode(transactionBase64([signature], message))).toEqual(serializeTransaction([signature], message))
  })

  test("is the message under a zero signature for each signer when unsigned", () => {
    expect(base64.decode(unsignedTransactionBase64(message))).toEqual(
      Uint8Array.of(1, ...new Uint8Array(64), ...message),
    )
  })

  test("refuses the wrong number of signatures, or one of the wrong length", () => {
    refusal(() => serializeTransaction([], message), "internal_error")
    refusal(() => serializeTransaction([new Uint8Array(64), new Uint8Array(64)], message), "internal_error")
    refusal(() => serializeTransaction([new Uint8Array(63)], message), "internal_error")
  })
})
