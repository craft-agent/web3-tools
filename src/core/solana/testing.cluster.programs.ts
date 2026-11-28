import { SOLANA_PROGRAMS, TOKEN_PROGRAMS } from "../chains/solana"
import { associatedTokenAddress } from "./address"
import type { SolanaAccountMeta, SolanaInstruction } from "./instructions"
import {
  rentMinimum,
  TOKEN_ACCOUNT_BYTES,
  tokenSpace,
  type FakeAccounts,
  type MintEntry,
  type PlainEntry,
  type TokenEntry,
} from "./testing.cluster.state"

/** The compute units each instruction consumes in the fake, which a dry run reports. */
export const UNITS = {
  system: 150,
  budget: 150,
  createAta: 4000,
  existingAta: 1500,
  transferChecked: 6200,
  revoke: 2900,
} as const

/** The token program's `TokenError`s the fake raises, by number, with the line the program logs. */
const TOKEN_ERRORS = {
  insufficientFunds: { code: 1, log: "insufficient funds" },
  mintMismatch: { code: 3, log: "Account not associated with this Mint" },
  ownerMismatch: { code: 4, log: "owner does not match" },
  accountFrozen: { code: 17, log: "Account is frozen" },
  decimalsMismatch: { code: 18, log: "decimals different from the Mint decimals" },
} as const

/** The System program's `InsufficientFunds`, which a transfer from an account with too few lamports raises. */
const SYSTEM_INSUFFICIENT_FUNDS = 1

const OPCODES = { systemTransfer: 2, createIdempotentAta: 1, transferChecked: 12, revoke: 5 } as const

const TRANSFER_DATA_BYTES = 12
const TRANSFER_CHECKED_DATA_BYTES = 10

/** An instruction that failed: `reason` is what the runtime puts after the instruction's index in the error. */
export class InstructionFailure extends Error {
  readonly reason: unknown
  /** The line the program logs before it fails, when it logs one. */
  readonly programLog: string | undefined

  constructor(reason: unknown, programLog?: string) {
    super(typeof reason === "string" ? reason : JSON.stringify(reason))
    this.reason = reason
    this.programLog = programLog
  }
}

/** What an instruction runs against: the accounts it may change and the meter of compute units. */
export type ExecContext = {
  accounts: FakeAccounts
  lamportsPerByte: bigint
  /** Counts `units`; fails the instruction when the limit is passed. */
  spend(units: number): void
}

function fail(reason: string): never {
  throw new InstructionFailure(reason)
}

function tokenFailure({ code, log }: { code: number; log: string }): never {
  throw new InstructionFailure({ Custom: code }, `Error: ${log}`)
}

function systemFailure(code: number, log: string): never {
  throw new InstructionFailure({ Custom: code }, log)
}

function accountsOf(ix: SolanaInstruction, count: number): SolanaAccountMeta[] {
  if (ix.accounts.length < count) fail("NotEnoughAccountKeys")
  return ix.accounts
}

function newWallet(): PlainEntry {
  return {
    kind: "plain",
    lamports: 0n,
    owner: SOLANA_PROGRAMS.systemProgram,
    executable: false,
    space: 0,
    data: new Uint8Array(),
  }
}

function dataView(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

function tokenAccountAt(ctx: ExecContext, address: string, program: string): TokenEntry {
  const entry = ctx.accounts.get(address)
  if (entry === undefined || entry.kind !== "token") return fail("InvalidAccountData")
  if (entry.owner !== program) return fail("IncorrectProgramId")
  return entry
}

function mintAt(ctx: ExecContext, address: string, program: string): MintEntry {
  const entry = ctx.accounts.get(address)
  if (entry === undefined || entry.kind !== "mint") return fail("InvalidAccountData")
  if (entry.owner !== program) return fail("IncorrectProgramId")
  return entry
}

/** The token program's `validate_owner`: `authority` must be `expected`, and sign. */
function validateOwner(authority: SolanaAccountMeta, expected: string): void {
  if (authority.address !== expected) tokenFailure(TOKEN_ERRORS.ownerMismatch)
  if (!authority.signer) fail("MissingRequiredSignature")
}

function systemTransfer(ctx: ExecContext, ix: SolanaInstruction): void {
  ctx.spend(UNITS.system)
  const [from, to] = accountsOf(ix, 2)
  const view = dataView(ix.data)
  if (ix.data.length !== TRANSFER_DATA_BYTES || view.getUint32(0, true) !== OPCODES.systemTransfer) {
    fail("InvalidInstructionData")
  }
  if (!from.signer) fail("MissingRequiredSignature")
  const lamports = view.getBigUint64(4, true)
  const source = ctx.accounts.get(from.address)
  if (
    source !== undefined &&
    (source.kind !== "plain" || source.owner !== SOLANA_PROGRAMS.systemProgram || source.space !== 0)
  ) {
    fail("InvalidArgument")
  }
  const held = source?.lamports ?? 0n
  if (held < lamports)
    systemFailure(SYSTEM_INSUFFICIENT_FUNDS, `Transfer: insufficient lamports ${held}, need ${lamports}`)
  if (source !== undefined) source.lamports -= lamports
  const target = ctx.accounts.get(to.address) ?? newWallet()
  target.lamports += lamports
  ctx.accounts.set(to.address, target)
}

function createIdempotentAta(ctx: ExecContext, ix: SolanaInstruction): void {
  const [payer, ata, owner, mintMeta, , programMeta] = accountsOf(ix, 6)
  if (ix.data.length !== 1 || ix.data[0] !== OPCODES.createIdempotentAta) fail("InvalidInstructionData")
  if (!TOKEN_PROGRAMS.includes(programMeta.address)) fail("IncorrectProgramId")
  const mint = mintAt(ctx, mintMeta.address, programMeta.address)
  if (associatedTokenAddress(owner.address, mintMeta.address, programMeta.address) !== ata.address) fail("InvalidSeeds")
  const existing = ctx.accounts.get(ata.address)
  const isFunded =
    existing?.kind === "plain" && existing.owner === SOLANA_PROGRAMS.systemProgram && existing.space === 0
  if (existing !== undefined && !isFunded) {
    ctx.spend(UNITS.existingAta)
    const isSame =
      existing.kind === "token" &&
      existing.owner === programMeta.address &&
      existing.mint === mintMeta.address &&
      existing.holder === owner.address
    if (!isSame) fail("IllegalOwner")
    return
  }
  ctx.spend(UNITS.createAta)
  if (!payer.signer) fail("MissingRequiredSignature")
  const extensions = programMeta.address === SOLANA_PROGRAMS.tokenProgram ? [] : [{ extension: "immutableOwner" }]
  const space = tokenSpace(programMeta.address, TOKEN_ACCOUNT_BYTES, extensions.length)
  const missing = rentMinimum(space, ctx.lamportsPerByte) - (existing?.lamports ?? 0n)
  const funder = ctx.accounts.get(payer.address)
  const held = funder?.lamports ?? 0n
  if (held < missing)
    systemFailure(SYSTEM_INSUFFICIENT_FUNDS, `Transfer: insufficient lamports ${held}, need ${missing}`)
  if (funder !== undefined) funder.lamports -= missing
  const isFrozen = mint.extensions.some(
    ({ extension, state }) => extension === "defaultAccountState" && state?.accountState === "frozen",
  )
  ctx.accounts.set(ata.address, {
    kind: "token",
    lamports: (existing?.lamports ?? 0n) + missing,
    owner: programMeta.address,
    executable: false,
    space,
    mint: mintMeta.address,
    holder: owner.address,
    amount: 0n,
    delegate: null,
    delegatedAmount: 0n,
    state: isFrozen ? "frozen" : "initialized",
    extensions,
  })
}

function transferChecked(ctx: ExecContext, ix: SolanaInstruction): void {
  ctx.spend(UNITS.transferChecked)
  const [sourceMeta, mintMeta, destinationMeta, authority] = accountsOf(ix, 4)
  if (ix.data.length !== TRANSFER_CHECKED_DATA_BYTES) fail("InvalidInstructionData")
  const amount = dataView(ix.data).getBigUint64(1, true)
  const decimals = ix.data[9]
  const source = tokenAccountAt(ctx, sourceMeta.address, ix.programId)
  const destination = tokenAccountAt(ctx, destinationMeta.address, ix.programId)
  const mint = mintAt(ctx, mintMeta.address, ix.programId)
  if (source.state === "frozen" || destination.state === "frozen") tokenFailure(TOKEN_ERRORS.accountFrozen)
  if (source.amount < amount) tokenFailure(TOKEN_ERRORS.insufficientFunds)
  if (source.mint !== mintMeta.address || destination.mint !== mintMeta.address) tokenFailure(TOKEN_ERRORS.mintMismatch)
  if (decimals !== mint.decimals) tokenFailure(TOKEN_ERRORS.decimalsMismatch)
  if (source.delegate !== null && authority.address === source.delegate) {
    validateOwner(authority, source.delegate)
    if (source.delegatedAmount < amount) tokenFailure(TOKEN_ERRORS.insufficientFunds)
    source.delegatedAmount -= amount
    if (source.delegatedAmount === 0n) source.delegate = null
  } else {
    validateOwner(authority, source.holder)
  }
  source.amount -= amount
  destination.amount += amount
}

function revoke(ctx: ExecContext, ix: SolanaInstruction): void {
  ctx.spend(UNITS.revoke)
  const [sourceMeta, authority] = accountsOf(ix, 2)
  if (ix.data.length !== 1) fail("InvalidInstructionData")
  const source = tokenAccountAt(ctx, sourceMeta.address, ix.programId)
  if (source.state === "frozen") tokenFailure(TOKEN_ERRORS.accountFrozen)
  validateOwner(authority, source.holder)
  source.delegate = null
  source.delegatedAmount = 0n
}

function tokenInstruction(ctx: ExecContext, ix: SolanaInstruction): void {
  if (ix.data[0] === OPCODES.transferChecked) return transferChecked(ctx, ix)
  if (ix.data[0] === OPCODES.revoke) return revoke(ctx, ix)
  fail("InvalidInstructionData")
}

function budgetInstruction(ctx: ExecContext): void {
  ctx.spend(UNITS.budget)
}

/** Runs `ix` against `ctx`, or fails it with an `InstructionFailure`; the programs the fake knows are System, Token, Token-2022, the associated token account program and the compute budget. */
export function runInstruction(ctx: ExecContext, ix: SolanaInstruction): void {
  switch (ix.programId) {
    case SOLANA_PROGRAMS.systemProgram:
      return systemTransfer(ctx, ix)
    case SOLANA_PROGRAMS.associatedTokenProgram:
      return createIdempotentAta(ctx, ix)
    case SOLANA_PROGRAMS.tokenProgram:
    case SOLANA_PROGRAMS.token2022Program:
      return tokenInstruction(ctx, ix)
    case SOLANA_PROGRAMS.computeBudgetProgram:
      return budgetInstruction(ctx)
    default:
      return fail("UnsupportedProgramId")
  }
}
