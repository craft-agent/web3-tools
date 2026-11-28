import { describe, expect, test } from "bun:test"
import { bytesToHex } from "@noble/curves/utils.js"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { isToolError } from "../errors"
import {
  erc1155SafeTransferFrom,
  erc20Approve,
  erc20Transfer,
  erc721SafeTransferFrom,
  setApprovalForAll,
} from "./calls"
import { MAX_UINT256 } from "./uint256"

const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
const DEAD = "0x000000000000000000000000000000000000dEaD"

const pad = (hex: string) => hex.padStart(64, "0")
const addressWord = (address: string) => pad(address.slice(2).toLowerCase())

/** The selector of `signature`, from its Keccak-256. */
function selectorOf(signature: string): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4))
}

function codeOf(work: () => unknown): string | undefined {
  try {
    work()
  } catch (error) {
    return isToolError(error) ? error.code : undefined
  }
  return undefined
}

describe("the selectors", () => {
  test.each([
    ["transfer(address,uint256)", () => erc20Transfer(ALICE, 1n)],
    ["approve(address,uint256)", () => erc20Approve(ALICE, 0n)],
    ["safeTransferFrom(address,address,uint256)", () => erc721SafeTransferFrom(ALICE, BOB, 1n)],
    ["safeTransferFrom(address,address,uint256,uint256,bytes)", () => erc1155SafeTransferFrom(ALICE, BOB, 1n, 1n)],
    ["setApprovalForAll(address,bool)", () => setApprovalForAll(ALICE, true)],
  ])("%s starts its call", (signature, encode) => {
    expect(encode().slice(2, 10)).toBe(selectorOf(signature))
  })
})

describe("the encodings", () => {
  test("transfer of 1e18 to 0x…dEaD", () => {
    expect(erc20Transfer(DEAD, 10n ** 18n)).toBe(`0xa9059cbb${"0".repeat(60)}dead${"0".repeat(49)}de0b6b3a7640000`)
  })

  test("transfer lays out the selector, the padded recipient and the amount", () => {
    expect(erc20Transfer(ALICE, 255n)).toBe(`0xa9059cbb${addressWord(ALICE)}${pad("ff")}`)
  })

  test("approve with 0 revokes, with the largest amount approves it all", () => {
    expect(erc20Approve(BOB, 0n)).toBe(`0x095ea7b3${addressWord(BOB)}${pad("0")}`)
    expect(erc20Approve(BOB, MAX_UINT256)).toBe(`0x095ea7b3${addressWord(BOB)}${"f".repeat(64)}`)
  })

  test("ERC-721 safeTransferFrom lays out from, to and the token id", () => {
    expect(erc721SafeTransferFrom(ALICE, BOB, 4242n)).toBe(
      `0x42842e0e${addressWord(ALICE)}${addressWord(BOB)}${pad("1092")}`,
    )
  })

  test("ERC-1155 safeTransferFrom ends with an empty bytes at offset 0xa0", () => {
    const call = erc1155SafeTransferFrom(ALICE, BOB, 7n, 3n)
    expect(call).toBe(`0xf242432a${addressWord(ALICE)}${addressWord(BOB)}${pad("7")}${pad("3")}${pad("a0")}${pad("0")}`)
    expect((call.length - 2) / 2).toBe(4 + 6 * 32)
  })

  test("setApprovalForAll encodes true as 1 and false as 0", () => {
    expect(setApprovalForAll(ALICE, true)).toBe(`0xa22cb465${addressWord(ALICE)}${pad("1")}`)
    expect(setApprovalForAll(ALICE, false)).toBe(`0xa22cb465${addressWord(ALICE)}${pad("0")}`)
  })

  test("every call is lower case hex", () => {
    for (const call of [erc20Transfer(BOB, 1n), erc721SafeTransferFrom(ALICE, BOB, 1n), setApprovalForAll(BOB, true)]) {
      expect(call).toMatch(/^0x[0-9a-f]+$/)
    }
  })
})

describe("the checks", () => {
  test("an address that is not one, or has a wrong checksum, is invalid_argument", () => {
    const wrong = ALICE.replace("C518", "c518")
    expect(wrong).not.toBe(ALICE)
    expect(codeOf(() => erc20Transfer("vitalik.eth", 1n))).toBe("invalid_argument")
    expect(codeOf(() => erc721SafeTransferFrom(ALICE, "0x1234", 1n))).toBe("invalid_argument")
    expect(codeOf(() => setApprovalForAll(wrong, true))).toBe("invalid_argument")
  })

  test("a number outside 0 … 2^256 - 1 is invalid_argument, in every kind", () => {
    expect(codeOf(() => erc20Transfer(BOB, -1n))).toBe("invalid_argument")
    expect(codeOf(() => erc20Approve(BOB, MAX_UINT256 + 1n))).toBe("invalid_argument")
    expect(codeOf(() => erc721SafeTransferFrom(ALICE, BOB, -1n))).toBe("invalid_argument")
    expect(codeOf(() => erc1155SafeTransferFrom(ALICE, BOB, MAX_UINT256 + 1n, 1n))).toBe("invalid_argument")
    expect(codeOf(() => erc1155SafeTransferFrom(ALICE, BOB, 1n, -1n))).toBe("invalid_argument")
  })

  test("the largest number is encoded", () => {
    expect(erc20Transfer(BOB, MAX_UINT256)).toBe(`0xa9059cbb${addressWord(BOB)}${"f".repeat(64)}`)
  })
})
