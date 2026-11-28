import { sha256 } from "@noble/hashes/sha2.js"
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { base58 } from "@scure/base"
import { SOLANA_PROGRAMS, solanaChain, type SolanaChain } from "../chains/solana"
import { ToolError } from "../errors"
import { solanaClient, type ClientOptions, type FetchLike, type JsonRpcClient } from "../rpc/client"
import { fakeRpc, type FakeRpcAnswer, type FakeRpcRequest } from "../rpc/testing"
import { associatedTokenAddress, metadataAddress } from "./address"
import {
  inContext,
  NODE_ERROR_CODES,
  never,
  preflightError,
  transportAnswer,
  type SendFailure,
} from "./testing.cluster.answers"
import { runTransaction } from "./testing.cluster.exec"
import { encodeMetadata, type MetadataInit } from "./testing.cluster.metadata"
import {
  accountValue,
  DEFAULT_LAMPORTS_PER_BYTE,
  MINT_BYTES,
  rentMinimum,
  TOKEN_ACCOUNT_BYTES,
  tokenSpace,
  type FakeAccounts,
  type FakeEntry,
  type FakeExtension,
  type MintEntry,
  type TokenEntry,
} from "./testing.cluster.state"
import { decodeTransaction, signaturesVerify, type FakeSolanaTx } from "./testing.cluster.tx"

export type { SendFailure } from "./testing.cluster.answers"
export type { FakeExtension, FakeEntry } from "./testing.cluster.state"
export type { FakeSolanaTx } from "./testing.cluster.tx"

/** The settings of a fake cluster; each is also a field a test may change later. */
export type FakeClusterOptions = Partial<
  Pick<FakeSolanaCluster, "blockHeight" | "lamportsPerByte" | "priorityFees" | "revertWhen">
>

/** What a mint is made with; every field has a default: the Token program, 6 decimals, a supply of 0 and no authority or extension. */
export type MintInit = {
  program?: string
  decimals?: number
  supply?: bigint
  mintAuthority?: string | null
  freezeAuthority?: string | null
  extensions?: FakeExtension[]
  /** Defaults to the lamports a rent-exempt account of its space holds. */
  lamports?: bigint
}

/** What a token account is made with; `program` defaults to its mint's, and the amount to 0. */
export type TokenAccountInit = {
  amount?: bigint
  delegate?: string | null
  delegatedAmount?: bigint
  state?: "initialized" | "frozen"
  extensions?: FakeExtension[]
  program?: string
  lamports?: bigint
}

/** What an account that holds no token state is made with. */
export type AccountInit = {
  lamports?: bigint
  owner?: string
  executable?: boolean
  /** Defaults to the length of `data`, or 0. */
  space?: number
  data?: Uint8Array
}

/** A transaction a `land` put in a block. */
export type LandedTransaction = { signature: string; err: unknown; fee: bigint; unitsConsumed: number }

type Handler = (params: unknown[]) => FakeRpcAnswer | Promise<FakeRpcAnswer>

type Status = { slot: bigint; err: unknown }

type SimulateConfig = {
  sigVerify?: boolean
  replaceRecentBlockhash?: boolean
  accounts?: { addresses?: unknown[]; encoding?: string }
}

/** How many blocks a blockhash stays valid for. */
const MAX_BLOCKHASH_AGE = 150n

/** How far the slot is ahead of the block height. */
const SLOT_OFFSET = 1000n

const FIRST_BLOCK_HEIGHT = 1000n

const DEFAULT_DECIMALS = 6

const BLOCKHASH_SEED = utf8ToBytes("fake blockhash")

const ENCODINGS = ["jsonParsed", "base64"] as const

/** The blockhash of block `height`: the same one every time, and a different one for each height. */
function blockhashAt(height: bigint): string {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, height)
  return base58.encode(sha256(concatBytes(BLOCKHASH_SEED, bytes)))
}

function invalidParams(message: string): FakeRpcAnswer {
  return { error: { code: NODE_ERROR_CODES.invalidParams, message } }
}

/**
 * A stateful stand-in for a Solana cluster, for tests: it answers JSON-RPC like a node through `fetch` (a client made
 * by `client()` reads it), keeps accounts, mints, token accounts and a set of pending transactions, and lands them on
 * request. Deterministic: no clock, no randomness. Test-only; nothing but tests imports it. It is a model, not a node:
 * it reads the latest state at any commitment, runs the fixed instructions of `instructions.ts` only (a System
 * transfer, an associated token account `CreateIdempotent`, `TransferChecked`, `Revoke` and the compute budget's),
 * knows no Token-2022 extension's effect on a transfer, and preflights a transaction's signatures, blockhash and fee
 * payer only, so one whose instructions would fail is accepted and lands with its error, as with `skipPreflight`.
 *
 * Setup: `setBalance`, `setAccount`, `addMint`, `addTokenAccount`, `addAssociatedTokenAccount`, `addMetadata`. Control:
 * `land`, `advance`, `failSend`, `inject`, `revertWhen`, and the fields `blockHeight`, `lamportsPerByte` and
 * `priorityFees`. Assertions: `requests`, `requestsOf`, `pending`, `statusOf`, `balanceOf`, `tokenBalanceOf`, `entryAt`.
 */
export class FakeSolanaCluster {
  readonly chain: SolanaChain
  blockHeight = FIRST_BLOCK_HEIGHT
  /** Rent per byte of an account and its 128 bytes of overhead: 5080, so 0 bytes hold 650,240 and 165 bytes 1,488,440. */
  lamportsPerByte = DEFAULT_LAMPORTS_PER_BYTE
  /** The prices, in micro-lamports per compute unit, that `getRecentPrioritizationFees` answers, newest first. */
  priorityFees: bigint[] = []
  /** A landed transaction for which this says true fails: the fee is charged and nothing else happens. */
  revertWhen: (tx: FakeSolanaTx) => boolean = () => false
  readonly fetch: FetchLike
  /** Every request received, in order. */
  readonly requests: FakeRpcRequest[]
  #accounts: FakeAccounts = new Map()
  #pool: FakeSolanaTx[] = []
  readonly #statuses = new Map<string, Status>()
  readonly #sendFailures: SendFailure[] = []
  readonly #injected = new Map<string, (FakeRpcAnswer | "timeout")[]>()

  /** A fake of the cluster `chain` names by key; `options` replace the defaults (block height 1000, no priority fees). */
  constructor(chain = "solana", options: FakeClusterOptions = {}) {
    this.chain = solanaChain(chain)
    Object.assign(this, options)
    const methods = Object.entries(this.#handlers()).map(([method, run]) => [
      method,
      (request: FakeRpcRequest) => this.#serve(method, request, run),
    ])
    const rpc = fakeRpc(Object.fromEntries(methods))
    this.fetch = rpc.fetch
    this.requests = rpc.requests
  }

  /** A client for the cluster's table entry that reads this fake; `options` are the client's (`timeoutMs`, `signal`). */
  client(options: ClientOptions = {}): JsonRpcClient {
    return solanaClient(this.chain, { fetch: this.fetch, env: {}, ...options })
  }

  /** The slot the cluster is at. */
  get slot(): bigint {
    return this.blockHeight + SLOT_OFFSET
  }

  /** The lamports an account of `space` bytes must hold to be rent exempt now. */
  rentFor(space: number): bigint {
    return rentMinimum(space, this.lamportsPerByte)
  }

  /** The blockhash the cluster hands out now. */
  get latestBlockhash(): string {
    return blockhashAt(this.blockHeight)
  }

  /** Sets the lamports of `address`; an account that holds none is gone, and a new one is a wallet. */
  setBalance(address: string, lamports: bigint): this {
    const entry = this.#accounts.get(address)
    if (entry !== undefined) entry.lamports = lamports
    else this.setAccount(address, { lamports })
    if (lamports === 0n) this.#accounts.delete(address)
    return this
  }

  /** Puts an account that holds no token state at `address`: a wallet by default, owned by the System program. */
  setAccount(address: string, init: AccountInit = {}): this {
    const space = init.space ?? init.data?.length ?? 0
    this.#accounts.set(address, {
      kind: "plain",
      lamports: init.lamports ?? this.rentFor(space),
      owner: init.owner ?? SOLANA_PROGRAMS.systemProgram,
      executable: init.executable ?? false,
      space,
      data: init.data ?? new Uint8Array(space),
    })
    return this
  }

  /** Puts a token mint at `address`. */
  addMint(address: string, init: MintInit = {}): this {
    const { extensions = [], program = SOLANA_PROGRAMS.tokenProgram } = init
    const space = tokenSpace(program, MINT_BYTES, extensions.length)
    const entry: MintEntry = {
      kind: "mint",
      lamports: init.lamports ?? this.rentFor(space),
      owner: program,
      executable: false,
      space,
      decimals: init.decimals ?? DEFAULT_DECIMALS,
      supply: init.supply ?? 0n,
      mintAuthority: init.mintAuthority ?? null,
      freezeAuthority: init.freezeAuthority ?? null,
      extensions,
    }
    this.#accounts.set(address, entry)
    return this
  }

  /** Puts a token account of `holder` for `mint` at `address`; its program is the mint's unless `init` says. */
  addTokenAccount(address: string, mint: string, holder: string, init: TokenAccountInit = {}): this {
    const known = this.#accounts.get(mint)
    const program = init.program ?? (known?.kind === "mint" ? known.owner : SOLANA_PROGRAMS.tokenProgram)
    const { extensions = [] } = init
    const space = tokenSpace(program, TOKEN_ACCOUNT_BYTES, extensions.length)
    const entry: TokenEntry = {
      kind: "token",
      lamports: init.lamports ?? this.rentFor(space),
      owner: program,
      executable: false,
      space,
      mint,
      holder,
      amount: init.amount ?? 0n,
      delegate: init.delegate ?? null,
      delegatedAmount: init.delegatedAmount ?? 0n,
      state: init.state ?? "initialized",
      extensions,
    }
    this.#accounts.set(address, entry)
    return this
  }

  /** Puts the associated token account of `holder` for `mint`, which must be in the fake, and returns its address. */
  addAssociatedTokenAccount(holder: string, mint: string, init: TokenAccountInit = {}): string {
    const known = this.#accounts.get(mint)
    if (known?.kind !== "mint") throw new ToolError("internal_error", `The fake has no mint ${mint}.`)
    const address = associatedTokenAddress(holder, mint, known.owner)
    this.addTokenAccount(address, mint, holder, init)
    return address
  }

  /** Puts the Token Metadata account of `init.mint` at its address, owned by Token Metadata, and returns the address. */
  addMetadata(init: MetadataInit): string {
    const address = metadataAddress(init.mint)
    this.setAccount(address, { owner: SOLANA_PROGRAMS.tokenMetadataProgram, data: encodeMetadata(init) })
    return address
  }

  /** The lamports of `address`. */
  balanceOf(address: string): bigint {
    return this.#accounts.get(address)?.lamports ?? 0n
  }

  /** The tokens in the token account at `address`; 0 when there is none. */
  tokenBalanceOf(address: string): bigint {
    const entry = this.#accounts.get(address)
    return entry?.kind === "token" ? entry.amount : 0n
  }

  /** What the cluster holds at `address`, as a copy to assert on. */
  entryAt(address: string): FakeEntry | undefined {
    const entry = this.#accounts.get(address)
    return entry === undefined ? undefined : structuredClone(entry)
  }

  /** The transactions accepted and not yet landed, in arrival order. */
  get pending(): readonly FakeSolanaTx[] {
    return this.#pool
  }

  /** How `signature` ended, once it has landed. */
  statusOf(signature: string): Status | undefined {
    return this.#statuses.get(signature)
  }

  /** The params of every request of `method`, in order. */
  requestsOf(method: string): unknown[][] {
    return this.requests.filter((request) => request.method === method).map((request) => request.params as unknown[])
  }

  /** Queues failures for the next `sendTransaction` calls, one each, in order. */
  failSend(...failures: SendFailure[]): this {
    this.#sendFailures.push(...failures)
    return this
  }

  /** Makes the next request of `method` answer `answer` (or never answer, for `"timeout"`) instead of the fake's own. */
  inject(method: string, answer: FakeRpcAnswer | "timeout"): this {
    this.#injected.set(method, [...(this.#injected.get(method) ?? []), answer])
    return this
  }

  /**
   * Puts the pending transactions in one new block, in arrival order. Each is charged and run (see `runTransaction`) and
   * gets a status at the slot; one whose blockhash has expired, or whose payer can no longer pay, is forgotten and gets
   * none. Returns what landed.
   */
  land(): LandedTransaction[] {
    this.blockHeight += 1n
    const landed: LandedTransaction[] = []
    for (const tx of this.#pool.splice(0)) {
      if (this.#heightOfBlockhash(tx.message.recentBlockhash) === undefined) continue
      const result = runTransaction(this.#accounts, tx, {
        lamportsPerByte: this.lamportsPerByte,
        forceFail: this.revertWhen(tx),
      })
      if (!result.landed) continue
      this.#accounts = result.accounts
      this.#statuses.set(tx.signature, { slot: this.slot, err: result.err })
      landed.push({ signature: tx.signature, err: result.err, fee: result.fee, unitsConsumed: result.unitsConsumed })
    }
    return landed
  }

  /** Moves the block height on by `blocks` with nothing landing, so that blockhashes expire; pending transactions that no longer can land are forgotten. */
  advance(blocks: number): this {
    this.blockHeight += BigInt(blocks)
    this.#pool = this.#pool.filter((tx) => this.#heightOfBlockhash(tx.message.recentBlockhash) !== undefined)
    return this
  }

  /** The height of the block `blockhash` was handed out at, while the cluster still takes it; else `undefined`. */
  #heightOfBlockhash(blockhash: string): bigint | undefined {
    const oldest = this.blockHeight > MAX_BLOCKHASH_AGE ? this.blockHeight - MAX_BLOCKHASH_AGE : 0n
    for (let height = this.blockHeight; height >= oldest; height--) {
      if (blockhashAt(height) === blockhash) return height
    }
    return undefined
  }

  #decode(text: unknown): FakeSolanaTx | FakeRpcAnswer {
    try {
      return decodeTransaction(String(text))
    } catch (error) {
      if (error instanceof ToolError) return invalidParams(error.message)
      throw error
    }
  }

  #preflight(tx: FakeSolanaTx): FakeRpcAnswer | undefined {
    if (!signaturesVerify(tx)) {
      return {
        error: { code: NODE_ERROR_CODES.signatureFailure, message: "Transaction signature verification failure" },
      }
    }
    if (this.#heightOfBlockhash(tx.message.recentBlockhash) === undefined) {
      return preflightError("Blockhash not found", "BlockhashNotFound")
    }
    if (this.#statuses.has(tx.signature)) {
      return preflightError("This transaction has already been processed", "AlreadyProcessed")
    }
    const result = runTransaction(this.#accounts, tx, { lamportsPerByte: this.lamportsPerByte, forceFail: false })
    if (result.landed) return undefined
    return result.err === "AccountNotFound"
      ? preflightError("Attempt to debit an account but found no record of a prior credit.", result.err)
      : preflightError("Insufficient funds for fee", result.err)
  }

  /** Checks a transaction as a node does and, when `store` is true, accepts it into the pending set. */
  #admit(text: unknown, store: boolean): FakeRpcAnswer {
    const tx = this.#decode(text)
    if (!("signature" in tx)) return tx
    const refusal = this.#preflight(tx)
    if (refusal) return refusal
    if (store && !this.#pool.some((held) => held.signature === tx.signature)) this.#pool.push(tx)
    return { result: tx.signature }
  }

  #send(params: unknown[]): FakeRpcAnswer | Promise<FakeRpcAnswer> {
    const failure = this.#sendFailures.shift()
    const transport = typeof failure === "object" && "transport" in failure ? failure : undefined
    if (typeof failure === "object" && "reject" in failure) return { error: failure.reject }
    if (transport && !transport.accepted) return transportAnswer(transport.transport)
    const answer = this.#admit(params[0], failure !== "drop")
    return transport && !("error" in answer) ? transportAnswer(transport.transport) : answer
  }

  #simulate([text, config]: unknown[]): FakeRpcAnswer {
    const tx = this.#decode(text)
    if (!("signature" in tx)) return tx
    const { sigVerify, replaceRecentBlockhash, accounts: watched } = (config ?? {}) as SimulateConfig
    if (watched !== undefined && watched.encoding !== "base64") {
      return invalidParams("The fake returns the accounts of a simulation as base64 only.")
    }
    const refusal =
      sigVerify === true && !signaturesVerify(tx)
        ? "SignatureFailure"
        : replaceRecentBlockhash !== true && this.#heightOfBlockhash(tx.message.recentBlockhash) === undefined
          ? "BlockhashNotFound"
          : undefined
    const result = refusal
      ? undefined
      : runTransaction(this.#accounts, tx, { lamportsPerByte: this.lamportsPerByte, forceFail: false })
    const err = refusal ?? result?.err ?? null
    const left =
      watched === undefined || err !== null || result === undefined
        ? null
        : (watched.addresses ?? []).map((address) => accountValue(result.accounts, String(address), "base64"))
    return inContext(this.slot, {
      err,
      logs: result?.logs ?? [],
      accounts: left,
      unitsConsumed: result?.unitsConsumed ?? 0,
      returnData: null,
    })
  }

  #statusOfEach(signatures: unknown): FakeRpcAnswer {
    const list = Array.isArray(signatures) ? signatures : []
    return inContext(
      this.slot,
      list.map((signature) => {
        const status = this.#statuses.get(String(signature))
        if (status === undefined) return null
        return {
          slot: Number(status.slot),
          confirmations: null,
          err: status.err,
          status: status.err === null ? { Ok: null } : { Err: status.err },
          confirmationStatus: "confirmed",
        }
      }),
    )
  }

  #accountInfo([address, config]: unknown[]): FakeRpcAnswer {
    const encoding = (config as { encoding?: string } | undefined)?.encoding
    if (!ENCODINGS.some((known) => known === encoding))
      return invalidParams("The fake serves jsonParsed and base64 only.")
    return inContext(this.slot, accountValue(this.#accounts, String(address), encoding as (typeof ENCODINGS)[number]))
  }

  #serve(method: string, request: FakeRpcRequest, run: Handler): FakeRpcAnswer | Promise<FakeRpcAnswer> {
    const injected = this.#injected.get(method)?.shift()
    if (injected === "timeout") return never()
    return injected ?? run(request.params as unknown[])
  }

  #handlers(): Record<string, Handler> {
    return {
      getAccountInfo: (params) => this.#accountInfo(params),
      getBalance: ([address]) => inContext(this.slot, Number(this.balanceOf(String(address)))),
      getMinimumBalanceForRentExemption: ([space]) => ({ result: Number(this.rentFor(Number(space))) }),
      getLatestBlockhash: () =>
        inContext(this.slot, {
          blockhash: this.latestBlockhash,
          lastValidBlockHeight: Number(this.blockHeight + MAX_BLOCKHASH_AGE),
        }),
      getBlockHeight: () => ({ result: Number(this.blockHeight) }),
      getSignatureStatuses: ([signatures]) => this.#statusOfEach(signatures),
      getRecentPrioritizationFees: () => ({
        result: this.priorityFees.map((fee, index) => ({
          slot: Number(this.slot) - index,
          prioritizationFee: Number(fee),
        })),
      }),
      simulateTransaction: (params) => this.#simulate(params),
      sendTransaction: (params) => this.#send(params),
    }
  }
}
