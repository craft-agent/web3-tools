import { SOLANA_PROGRAMS, TOKEN_PROGRAMS } from "../chains/solana"
import { ToolError } from "../errors"
import { parseSolanaAddress } from "./address"

/** One account an instruction names. */
export type SolanaAccountMeta = { address: string; signer: boolean; writable: boolean }

/** One instruction: the program that runs it, the accounts it names and its data. */
export type SolanaInstruction = { programId: string; accounts: SolanaAccountMeta[]; data: Uint8Array }

/** The opcode that starts each instruction's data; the System program's is a u32, the others' one byte. */
const OPCODES = {
  /** System `Transfer`, a u32. */
  systemTransfer: 2,
  /** Token `Revoke`. */
  revoke: 5,
  /** Token `TransferChecked`. */
  transferChecked: 12,
  /** Associated Token Account `CreateIdempotent`. */
  createIdempotent: 1,
  /** Compute Budget `SetComputeUnitLimit`. */
  setComputeUnitLimit: 2,
  /** Compute Budget `SetComputeUnitPrice`. */
  setComputeUnitPrice: 3,
}

const MAX_U8 = 0xff
const MAX_U32 = 0xffff_ffff
const MAX_U64 = 2n ** 64n - 1n

const U32_BYTES = 4
const U64_BYTES = 8

function meta(address: string, name: string, signer: boolean, writable: boolean): SolanaAccountMeta {
  return { address: parseSolanaAddress(address, name), signer, writable }
}

function checkWhole(value: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ToolError("invalid_argument", `The ${name} must be a whole number from 0 to ${max}.`)
  }
  return value
}

function checkU64(value: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    throw new ToolError("invalid_argument", `The ${name} must be a whole number from 0 to 2^64 - 1.`)
  }
  return value
}

function checkTokenProgram(program: string): string {
  if (!TOKEN_PROGRAMS.includes(program)) {
    throw new ToolError("invalid_argument", "The token program must be the Token or the Token-2022 program.")
  }
  return program
}

function u32le(value: number): Uint8Array {
  const bytes = new Uint8Array(U32_BYTES)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

function u64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(U64_BYTES)
  new DataView(bytes.buffer).setBigUint64(0, value, true)
  return bytes
}

/** System `Transfer`: `lamports` from `from`, which signs, to `to`. */
export function systemTransfer(from: string, to: string, lamports: bigint): SolanaInstruction {
  return {
    programId: SOLANA_PROGRAMS.systemProgram,
    accounts: [meta(from, "sender", true, true), meta(to, "recipient", false, true)],
    data: Uint8Array.of(...u32le(OPCODES.systemTransfer), ...u64le(checkU64(lamports, "amount of lamports"))),
  }
}

/**
 * Token `TransferChecked` under `tokenProgram` (Token or Token-2022): `amount`
 * base units of `mint`, which has `decimals`, from `source` to `destination`,
 * with `owner` signing.
 */
export function transferChecked(
  tokenProgram: string,
  source: string,
  mint: string,
  destination: string,
  owner: string,
  amount: bigint,
  decimals: number,
): SolanaInstruction {
  return {
    programId: checkTokenProgram(tokenProgram),
    accounts: [
      meta(source, "source token account", false, true),
      meta(mint, "mint", false, false),
      meta(destination, "destination token account", false, true),
      meta(owner, "owner", true, false),
    ],
    data: Uint8Array.of(
      OPCODES.transferChecked,
      ...u64le(checkU64(amount, "token amount")),
      checkWhole(decimals, MAX_U8, "token decimals"),
    ),
  }
}

/**
 * Associated Token Account `CreateIdempotent`: makes `ata`, the token account
 * of `owner` for `mint` under `tokenProgram`, paid for by `payer`, and does
 * nothing when it exists.
 */
export function createIdempotentAta(
  payer: string,
  ata: string,
  owner: string,
  mint: string,
  tokenProgram: string,
): SolanaInstruction {
  return {
    programId: SOLANA_PROGRAMS.associatedTokenProgram,
    accounts: [
      meta(payer, "payer", true, true),
      meta(ata, "associated token account", false, true),
      meta(owner, "owner", false, false),
      meta(mint, "mint", false, false),
      meta(SOLANA_PROGRAMS.systemProgram, "System program", false, false),
      meta(checkTokenProgram(tokenProgram), "token program", false, false),
    ],
    data: Uint8Array.of(OPCODES.createIdempotent),
  }
}

/** Token `Revoke` under `tokenProgram`: ends the delegate of `source`, with `owner` signing. */
export function revoke(tokenProgram: string, source: string, owner: string): SolanaInstruction {
  return {
    programId: checkTokenProgram(tokenProgram),
    accounts: [meta(source, "source token account", false, true), meta(owner, "owner", true, false)],
    data: Uint8Array.of(OPCODES.revoke),
  }
}

/** Compute Budget `SetComputeUnitLimit`: at most `units` compute units, a u32. */
export function setComputeUnitLimit(units: number): SolanaInstruction {
  return {
    programId: SOLANA_PROGRAMS.computeBudgetProgram,
    accounts: [],
    data: Uint8Array.of(OPCODES.setComputeUnitLimit, ...u32le(checkWhole(units, MAX_U32, "compute unit limit"))),
  }
}

/** Compute Budget `SetComputeUnitPrice`: `microLamports` per compute unit, a u64. */
export function setComputeUnitPrice(microLamports: bigint): SolanaInstruction {
  return {
    programId: SOLANA_PROGRAMS.computeBudgetProgram,
    accounts: [],
    data: Uint8Array.of(OPCODES.setComputeUnitPrice, ...u64le(checkU64(microLamports, "compute unit price"))),
  }
}
