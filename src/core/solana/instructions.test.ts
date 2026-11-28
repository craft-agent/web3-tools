import { describe, expect, test } from "bun:test"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { isToolError } from "../errors"
import {
  createIdempotentAta,
  revoke,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  transferChecked,
} from "./instructions"

const ALICE = "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1"
const BOB = "J3dxNj7nDRRqRRXuEMynDG57DkZK4jYRuv3Garmb1i99"
const MINT = "7o36UsWR1JQLpZ9PE2gn9L4SQ69CNNiWAXd4Jt7rqz9Z"
const ALICE_ATA = "DShWnroshVbeUp28oopA3Pu7oFPDBtC1DBmPECXXAQ9n"
const BOB_ATA = "5nu6HDY7t1Ds8oPNsArrhb1rzvRqmGubyteyAUncFyNb"

function expectRefusal(work: () => unknown): void {
  try {
    work()
  } catch (error) {
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    return
  }
  throw new Error("the call did not refuse")
}

describe("systemTransfer", () => {
  test("is System index 2 as u32, then the lamports as u64, both little-endian", () => {
    // The data of micro-sol-signer's transaction vector (test/basic.test.ts): 49 lamports.
    expect(systemTransfer(ALICE, BOB, 49n)).toEqual({
      programId: SOLANA_PROGRAMS.systemProgram,
      accounts: [
        { address: ALICE, signer: true, writable: true },
        { address: BOB, signer: false, writable: true },
      ],
      data: Uint8Array.of(2, 0, 0, 0, 49, 0, 0, 0, 0, 0, 0, 0),
    })
    expect(systemTransfer(ALICE, BOB, 0x0102030405060708n).data).toEqual(
      Uint8Array.of(2, 0, 0, 0, 8, 7, 6, 5, 4, 3, 2, 1),
    )
  })

  test("takes 0 to 2^64 - 1 lamports and nothing else", () => {
    expect(systemTransfer(ALICE, BOB, 2n ** 64n - 1n).data.slice(4)).toEqual(new Uint8Array(8).fill(0xff))
    expect(systemTransfer(ALICE, BOB, 0n).data.slice(4)).toEqual(new Uint8Array(8))
    expectRefusal(() => systemTransfer(ALICE, BOB, 2n ** 64n))
    expectRefusal(() => systemTransfer(ALICE, BOB, -1n))
    expectRefusal(() => systemTransfer(ALICE, BOB, 1 as unknown as bigint))
  })

  test("refuses an address that is not one", () => {
    expectRefusal(() => systemTransfer("alice", BOB, 1n))
    expectRefusal(() => systemTransfer(ALICE, "bob", 1n))
  })
})

describe("transferChecked", () => {
  test("is 12, the amount as u64 and the decimals, under the given token program", () => {
    for (const program of [SOLANA_PROGRAMS.tokenProgram, SOLANA_PROGRAMS.token2022Program]) {
      expect(transferChecked(program, ALICE_ATA, MINT, BOB_ATA, ALICE, 12345n, 4)).toEqual({
        programId: program,
        accounts: [
          { address: ALICE_ATA, signer: false, writable: true },
          { address: MINT, signer: false, writable: false },
          { address: BOB_ATA, signer: false, writable: true },
          { address: ALICE, signer: true, writable: false },
        ],
        data: Uint8Array.of(12, 0x39, 0x30, 0, 0, 0, 0, 0, 0, 4),
      })
    }
  })

  test("takes decimals 0 to 255 and an amount up to 2^64 - 1", () => {
    const data = transferChecked(
      SOLANA_PROGRAMS.tokenProgram,
      ALICE_ATA,
      MINT,
      BOB_ATA,
      ALICE,
      2n ** 64n - 1n,
      255,
    ).data
    expect(data).toEqual(Uint8Array.of(12, ...new Array(8).fill(0xff), 255))
    for (const decimals of [-1, 256, 1.5, Number.NaN]) {
      expectRefusal(() => transferChecked(SOLANA_PROGRAMS.tokenProgram, ALICE_ATA, MINT, BOB_ATA, ALICE, 1n, decimals))
    }
    expectRefusal(() => transferChecked(SOLANA_PROGRAMS.tokenProgram, ALICE_ATA, MINT, BOB_ATA, ALICE, 2n ** 64n, 0))
  })

  test("refuses a program that is not Token or Token-2022", () => {
    for (const program of [SOLANA_PROGRAMS.systemProgram, SOLANA_PROGRAMS.associatedTokenProgram, "Token"]) {
      expectRefusal(() => transferChecked(program, ALICE_ATA, MINT, BOB_ATA, ALICE, 1n, 0))
    }
  })
})

describe("createIdempotentAta", () => {
  test("is the ATA program's 1, with the payer, account, owner, mint, System and token program", () => {
    expect(createIdempotentAta(ALICE, BOB_ATA, BOB, MINT, SOLANA_PROGRAMS.token2022Program)).toEqual({
      programId: SOLANA_PROGRAMS.associatedTokenProgram,
      accounts: [
        { address: ALICE, signer: true, writable: true },
        { address: BOB_ATA, signer: false, writable: true },
        { address: BOB, signer: false, writable: false },
        { address: MINT, signer: false, writable: false },
        { address: SOLANA_PROGRAMS.systemProgram, signer: false, writable: false },
        { address: SOLANA_PROGRAMS.token2022Program, signer: false, writable: false },
      ],
      data: Uint8Array.of(1),
    })
  })

  test("refuses a token program that is not Token or Token-2022", () => {
    expectRefusal(() => createIdempotentAta(ALICE, BOB_ATA, BOB, MINT, SOLANA_PROGRAMS.systemProgram))
  })
})

describe("revoke", () => {
  test("is 5, with the source writable and the owner signing", () => {
    expect(revoke(SOLANA_PROGRAMS.tokenProgram, ALICE_ATA, ALICE)).toEqual({
      programId: SOLANA_PROGRAMS.tokenProgram,
      accounts: [
        { address: ALICE_ATA, signer: false, writable: true },
        { address: ALICE, signer: true, writable: false },
      ],
      data: Uint8Array.of(5),
    })
  })

  test("refuses a program that is not Token or Token-2022", () => {
    expectRefusal(() => revoke(SOLANA_PROGRAMS.computeBudgetProgram, ALICE_ATA, ALICE))
  })
})

describe("the compute budget", () => {
  test("SetComputeUnitLimit is 2 and a u32", () => {
    expect(setComputeUnitLimit(200_000)).toEqual({
      programId: SOLANA_PROGRAMS.computeBudgetProgram,
      accounts: [],
      data: Uint8Array.of(2, 0x40, 0x0d, 0x03, 0),
    })
    expect(setComputeUnitLimit(0xffff_ffff).data).toEqual(Uint8Array.of(2, 255, 255, 255, 255))
    for (const units of [-1, 2 ** 32, 1.5, Number.NaN]) expectRefusal(() => setComputeUnitLimit(units))
  })

  test("SetComputeUnitPrice is 3 and a u64", () => {
    expect(setComputeUnitPrice(1_000_000n)).toEqual({
      programId: SOLANA_PROGRAMS.computeBudgetProgram,
      accounts: [],
      data: Uint8Array.of(3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0),
    })
    expect(setComputeUnitPrice(2n ** 64n - 1n).data).toEqual(Uint8Array.of(3, ...new Array(8).fill(0xff)))
    expectRefusal(() => setComputeUnitPrice(2n ** 64n))
    expectRefusal(() => setComputeUnitPrice(-1n))
  })
})
