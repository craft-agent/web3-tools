import { Transaction } from "micro-eth-signer"
import { evmChain, FEE_ORACLES, type EvmChain } from "../chains/evm"
import { evmClient, type ClientOptions, type FetchLike, type JsonRpcClient } from "../rpc/client"
import { fakeRpc, type FakeRpcAnswer, type FakeRpcRequest } from "../rpc/testing"
import { quantityHex } from "./abi"
import {
  never,
  methodNotFound,
  nodeError,
  oracleOutcome,
  outcomeAnswer,
  quantity,
  revertAnswer,
  toBigInt,
  transportAnswer,
  type FakeLineaEstimate,
  type FakeOracle,
  type SendFailure,
} from "./testing.answers"
import {
  addressKey,
  newErc1155,
  newErc20,
  newErc721,
  runContractCall,
  selectorOf,
  type CallOutcome,
  type Erc1155Init,
  type Erc20Init,
  type Erc721Init,
  type FakeContract,
  type FakeErc1155,
  type FakeErc20,
  type FakeErc721,
} from "./testing.contracts"
import { blockHashOf, receiptObject, transactionObject, type FakeReceipt, type FakeTx } from "./testing.shapes"

export * from "./testing.contracts"
export type { FakeLineaEstimate, FakeOracle, SendFailure } from "./testing.answers"
export type { FakeReceipt, FakeTx } from "./testing.shapes"

/** The settings of a fake chain; each is also a field a test may change later. */
export type FakeEvmOptions = Partial<
  Pick<
    FakeEvmChain,
    | "chainId"
    | "blockNumber"
    | "baseFee"
    | "priorityFee"
    | "gasPrice"
    | "contractGas"
    | "estimateRevert"
    | "oracle"
    | "linea"
    | "autoMineAfterPolls"
  >
>

type Account = { balance: bigint; nonce: bigint }

type Handler = (params: unknown[]) => FakeRpcAnswer | Promise<FakeRpcAnswer>

type CallObject = { from?: string; to?: string; data?: string; input?: string; value?: string }

const ZERO_ADDRESS = `0x${"0".repeat(40)}`
const GWEI = 10n ** 9n
const PLAIN_TRANSFER_GAS = 21_000n
const BLOCK_GAS_LIMIT = 30_000_000n
const SECONDS_PER_BLOCK = 12n
/** A replacement must raise both fees to this many percent of the old ones. */
const REPLACEMENT_PERCENT = 110n

const SELECTORS = {
  getL1Fee: selectorOf("getL1Fee(bytes)"),
  getOperatorFee: selectorOf("getOperatorFee(uint256)"),
  tokenRatio: selectorOf("tokenRatio()"),
}

/**
 * A stateful stand-in for an EVM node, for tests: it answers JSON-RPC like one through `fetch` (a client made by
 * `client()` reads it), keeps accounts, contracts and a mempool, and mines on request. Deterministic: no clock, no
 * randomness. Test-only; nothing but tests imports it. It is a model, not a node: it knows the latest block (a
 * call's block argument is ignored, but for the pending nonce and `eth_getBlockByNumber`), does not charge an L1
 * data fee when it mines, and runs the fixed calls of `calls.ts` and the reads of `reads.ts` only.
 *
 * Setup: `setBalance`, `setNonce`, `addContract`, `addErc20`, `addErc721`, `addErc1155`. Control: `mine`,
 * `failSend`, `inject`, `autoMineAfterPolls`, `estimateRevert`, `revertWhen`. Assertions: `requests`,
 * `requestsOf`, `pending`, `receiptOf`, `balanceOf`, `nonceOf`, `contractAt`.
 */
export class FakeEvmChain {
  readonly chain: EvmChain
  chainId: number
  blockNumber = 100n
  /** The latest block's base fee per gas; `undefined` for a chain without one (its blocks carry no `baseFeePerGas`). */
  baseFee: bigint | undefined = GWEI
  /** What `eth_maxPriorityFeePerGas` answers; `"unsupported"` makes the method not found. */
  priorityFee: bigint | "unsupported" = GWEI / 10n
  /** What `eth_gasPrice` answers; by default the base fee and the priority fee. */
  gasPrice: bigint | undefined
  /** The gas of a call to a contract, or with data: what `eth_estimateGas` answers and a mined call uses. */
  contractGas = 65_000n
  /** When set, `eth_estimateGas` reverts with this reason, whatever the call. */
  estimateRevert: string | undefined
  oracle: FakeOracle = { l1Fee: 10n ** 12n, operatorFee: 0n, tokenRatio: 1n }
  /** What `linea_estimateGas` answers; `undefined` makes the method not found. */
  linea: FakeLineaEstimate | undefined
  /** When set, every Nth `eth_getTransactionReceipt` request mines a block before it is answered. */
  autoMineAfterPolls: number | undefined
  /** A mined transaction for which this says true reverts: the fee is charged and nothing else happens. */
  revertWhen: (tx: FakeTx) => boolean = () => false
  readonly fetch: FetchLike
  /** Every request received, in order. */
  readonly requests: FakeRpcRequest[]
  readonly #accounts = new Map<string, Account>()
  readonly #contracts = new Map<string, FakeContract>()
  readonly #pool: FakeTx[] = []
  readonly #mined = new Map<string, FakeReceipt>()
  readonly #blocks = new Map<bigint, string[]>()
  readonly #sendFailures: SendFailure[] = []
  readonly #injected = new Map<string, (FakeRpcAnswer | "timeout")[]>()
  #polls = 0

  /** A fake of the chain `chain` names by key; `options` replace the defaults (the table's chain id, block 100, a base fee of 1 gwei). */
  constructor(chain: string, options: FakeEvmOptions = {}) {
    this.chain = evmChain(chain)
    this.chainId = this.chain.chainId
    Object.assign(this, options)
    const methods = Object.entries(this.#handlers()).map(([method, run]) => [
      method,
      (request: FakeRpcRequest) => this.#serve(method, request, run),
    ])
    const rpc = fakeRpc(Object.fromEntries(methods))
    this.fetch = rpc.fetch
    this.requests = rpc.requests
  }

  /** A client for the chain's table entry that reads this fake; `options` are the client's (`timeoutMs`, `signal`). */
  client(options: ClientOptions = {}): JsonRpcClient {
    return evmClient(this.chain, { fetch: this.fetch, env: {}, ...options })
  }

  /** Sets the balance of `address`, in wei. */
  setBalance(address: string, wei: bigint): this {
    this.#account(address).balance = wei
    return this
  }

  /** Sets the number of transactions `address` has sent (mined). */
  setNonce(address: string, nonce: bigint): this {
    this.#account(address).nonce = nonce
    return this
  }

  /** The balance of `address`, in wei. */
  balanceOf(address: string): bigint {
    return this.#account(address).balance
  }

  /** The mined nonce of `address`. */
  nonceOf(address: string): bigint {
    return this.#account(address).nonce
  }

  /** Puts `contract` (code and state) at `address`; a plain contract by default. */
  addContract(address: string, contract: FakeContract = { kind: "plain" }): this {
    this.#contracts.set(addressKey(address), contract)
    return this
  }

  /** Puts an ERC-20 at `address`; returns it, its maps being the state a test asserts on. */
  addErc20(address: string, init?: Erc20Init): FakeErc20 {
    const token = newErc20(init)
    this.addContract(address, token)
    return token
  }

  /** Puts an ERC-721 contract at `address`; returns it. */
  addErc721(address: string, init?: Erc721Init): FakeErc721 {
    const nft = newErc721(init)
    this.addContract(address, nft)
    return nft
  }

  /** Puts an ERC-1155 contract at `address`; returns it. */
  addErc1155(address: string, init?: Erc1155Init): FakeErc1155 {
    const token = newErc1155(init)
    this.addContract(address, token)
    return token
  }

  /** The contract at `address`, if any. */
  contractAt(address: string): FakeContract | undefined {
    return this.#contracts.get(addressKey(address))
  }

  /** The transactions in the mempool, in arrival order. */
  get pending(): readonly FakeTx[] {
    return this.#pool
  }

  /** The receipt of a mined transaction. */
  receiptOf(hash: string): FakeReceipt | undefined {
    return this.#mined.get(hash.toLowerCase())
  }

  /** The params of every request of `method`, in order. */
  requestsOf(method: string): unknown[][] {
    return this.requests.filter((request) => request.method === method).map((request) => request.params as unknown[])
  }

  /** Queues failures for the next `eth_sendRawTransaction` calls, one each, in order. */
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
   * Mines one block with every transaction whose nonce is its sender's next, in arrival order, so a sender's own
   * come in nonce order. Each uses its gas, is charged `gasUsed × effective price` and, unless it reverts,
   * moves its value and does what its call does. A transaction with a gap before it stays in the mempool.
   * Returns the receipts.
   */
  mine(): FakeReceipt[] {
    this.blockNumber += 1n
    const receipts: FakeReceipt[] = []
    for (;;) {
      const index = this.#pool.findIndex((tx) => tx.nonce === this.#account(tx.from).nonce)
      if (index < 0) break
      const [tx] = this.#pool.splice(index, 1)
      receipts.push(this.#execute(tx, receipts.length))
    }
    this.#blocks.set(
      this.blockNumber,
      receipts.map((receipt) => receipt.tx.hash),
    )
    return receipts
  }

  #account(address: string): Account {
    const key = addressKey(address)
    const account = this.#accounts.get(key) ?? { balance: 0n, nonce: 0n }
    this.#accounts.set(key, account)
    return account
  }

  #held(from: string, nonce: bigint): FakeTx | undefined {
    return this.#pool.find((tx) => addressKey(tx.from) === addressKey(from) && tx.nonce === nonce)
  }

  #pendingNonce(address: string): bigint {
    let next = this.#account(address).nonce
    while (this.#held(address, next)) next += 1n
    return next
  }

  #gasRequired(to: string, data: string): bigint {
    return this.#contracts.has(addressKey(to)) || data !== "0x" ? this.contractGas : PLAIN_TRANSFER_GAS
  }

  #execute(tx: FakeTx, index: number): FakeReceipt {
    const sender = this.#account(tx.from)
    const required = this.#gasRequired(tx.to, tx.data)
    const contract = this.#contracts.get(addressKey(tx.to))
    const outcome = contract && tx.data !== "0x" ? runContractCall(contract, tx.from, tx.data) : undefined
    const hasGas = tx.gasLimit >= required
    const succeeds = hasGas && !this.revertWhen(tx) && !(outcome && "revert" in outcome)
    const gasUsed = hasGas ? required : tx.gasLimit
    const effectiveGasPrice = this.#effectiveGasPrice(tx)
    const fee = gasUsed * effectiveGasPrice
    sender.balance -= fee < sender.balance ? fee : sender.balance
    sender.nonce += 1n
    let status: 0 | 1 = 0
    if (succeeds && sender.balance >= tx.value) {
      status = 1
      sender.balance -= tx.value
      this.#account(tx.to).balance += tx.value
      if (outcome && "effect" in outcome) outcome.effect?.()
    }
    const receipt: FakeReceipt = { tx, blockNumber: this.blockNumber, index, status, gasUsed, effectiveGasPrice }
    this.#mined.set(tx.hash, receipt)
    return receipt
  }

  #effectiveGasPrice(tx: FakeTx): bigint {
    const capped = (this.baseFee ?? 0n) + tx.maxPriorityFeePerGas
    return capped < tx.maxFeePerGas ? capped : tx.maxFeePerGas
  }

  #decode(raw: unknown): FakeTx | FakeRpcAnswer {
    let decoded
    let from
    try {
      decoded = Transaction.fromHex(String(raw))
      from = decoded.recoverSender().address
    } catch {
      return nodeError("invalid transaction")
    }
    const fields = decoded.raw
    if (decoded.type !== "eip1559" || !("maxFeePerGas" in fields) || fields.to === undefined) {
      return nodeError("transaction type not supported")
    }
    if (Number(fields.chainId) !== this.chainId) {
      return nodeError(`invalid sender: invalid chain id for signer, have ${fields.chainId} want ${this.chainId}`)
    }
    const { nonce, to, value, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas } = fields
    return { hash: decoded.hash, from, nonce, to, value, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas }
  }

  #refuse(tx: FakeTx): FakeRpcAnswer | undefined {
    if (this.#mined.has(tx.hash) || this.#pool.some((held) => held.hash === tx.hash)) return nodeError("already known")
    if (tx.gasLimit < PLAIN_TRANSFER_GAS) return nodeError("intrinsic gas too low")
    const confirmed = this.#account(tx.from).nonce
    if (tx.nonce < confirmed) return nodeError(`nonce too low: next nonce ${confirmed}, tx nonce ${tx.nonce}`)
    const taken = this.#held(tx.from, tx.nonce)
    if (taken && !isBump(taken, tx)) return nodeError("replacement transaction underpriced")
    const next = this.#pendingNonce(tx.from)
    if (!taken && tx.nonce > next) return nodeError(`nonce too high: next nonce ${next}, tx nonce ${tx.nonce}`)
    const cost = tx.value + tx.gasLimit * tx.maxFeePerGas
    const balance = this.balanceOf(tx.from)
    if (balance < cost) {
      return nodeError(`insufficient funds for gas * price + value: address ${tx.from} have ${balance} want ${cost}`)
    }
    return undefined
  }

  /** Checks a raw transaction as a node does and, when `store` is true, puts it in the mempool (in place of the one it replaces). */
  #admit(raw: unknown, store: boolean): FakeRpcAnswer {
    const tx = this.#decode(raw)
    if (!("hash" in tx)) return tx
    const refusal = this.#refuse(tx)
    if (refusal) return refusal
    const replaced = this.#held(tx.from, tx.nonce)
    if (replaced) this.#pool.splice(this.#pool.indexOf(replaced), 1)
    if (store) this.#pool.push(tx)
    return { result: tx.hash }
  }

  #send(params: unknown[]): FakeRpcAnswer | Promise<FakeRpcAnswer> {
    const failure = this.#sendFailures.shift()
    const transport = typeof failure === "object" && "transport" in failure ? failure : undefined
    if (typeof failure === "object" && "reject" in failure) return { error: failure.reject }
    if (transport && !transport.accepted) return transportAnswer(transport.transport)
    const answer = this.#admit(params[0], failure !== "drop")
    return transport && !("error" in answer) ? transportAnswer(transport.transport) : answer
  }

  #serve(method: string, request: FakeRpcRequest, run: Handler): FakeRpcAnswer | Promise<FakeRpcAnswer> {
    const injected = this.#injected.get(method)?.shift()
    if (injected === "timeout") return never()
    return injected ?? run(request.params as unknown[])
  }

  #oracleCall(to: string, data: string): CallOutcome | undefined {
    const key = addressKey(to)
    const isOp = key === addressKey(FEE_ORACLES.op)
    if (!isOp && key !== addressKey(FEE_ORACLES.scroll)) return undefined
    const selector = data.slice(2, 10).toLowerCase()
    if (selector === SELECTORS.getL1Fee) return oracleOutcome(this.oracle.l1Fee)
    if (isOp && selector === SELECTORS.getOperatorFee) return oracleOutcome(this.oracle.operatorFee)
    if (isOp && selector === SELECTORS.tokenRatio) return oracleOutcome(this.oracle.tokenRatio)
    return { revert: "" }
  }

  #call(from: string, to: string, data: string): CallOutcome {
    const contract = this.#contracts.get(addressKey(to))
    return this.#oracleCall(to, data) ?? (contract ? runContractCall(contract, from, data) : { returns: "0x" })
  }

  #estimate(call: CallObject): FakeRpcAnswer {
    if (this.estimateRevert !== undefined) return revertAnswer(this.estimateRevert)
    const to = call.to ?? ZERO_ADDRESS
    const data = call.data ?? call.input ?? "0x"
    if (call.from !== undefined && this.balanceOf(call.from) < toBigInt(call.value)) {
      return nodeError("insufficient funds for transfer")
    }
    const outcome = this.#call(call.from ?? ZERO_ADDRESS, to, data)
    return "revert" in outcome ? revertAnswer(outcome.revert) : quantity(this.#gasRequired(to, data))
  }

  #block(tag: unknown): FakeRpcAnswer {
    const isLatest = tag === "latest" || tag === "pending" || tag === undefined
    const number = isLatest ? this.blockNumber : toBigInt(tag)
    if (number > this.blockNumber) return { result: null }
    return {
      result: {
        number: quantityHex(number),
        hash: blockHashOf(number),
        parentHash: blockHashOf(number - 1n),
        timestamp: quantityHex(number * SECONDS_PER_BLOCK),
        gasLimit: quantityHex(BLOCK_GAS_LIMIT),
        gasUsed: "0x0",
        transactions: this.#blocks.get(number) ?? [],
        ...(this.baseFee === undefined ? {} : { baseFeePerGas: quantityHex(this.baseFee) }),
      },
    }
  }

  #receipt(hash: unknown): FakeRpcAnswer {
    this.#polls += 1
    if (this.autoMineAfterPolls !== undefined && this.#polls >= this.autoMineAfterPolls) {
      this.#polls = 0
      this.mine()
    }
    const receipt = this.receiptOf(String(hash))
    return { result: receipt ? receiptObject(receipt) : null }
  }

  #transactionByHash(hash: unknown): FakeRpcAnswer {
    const key = String(hash).toLowerCase()
    const receipt = this.#mined.get(key)
    const tx = receipt?.tx ?? this.#pool.find((held) => held.hash === key)
    return { result: tx ? transactionObject(tx, this.chainId, receipt) : null }
  }

  #handlers(): Record<string, Handler> {
    const callObject = (params: unknown[]) => (params[0] ?? {}) as CallObject
    return {
      eth_chainId: () => quantity(BigInt(this.chainId)),
      eth_blockNumber: () => quantity(this.blockNumber),
      eth_getBalance: ([address]) => quantity(this.balanceOf(String(address))),
      eth_getTransactionCount: ([address, tag]) =>
        quantity(tag === "pending" ? this.#pendingNonce(String(address)) : this.nonceOf(String(address))),
      eth_getCode: ([address]) => ({
        result: this.#contracts.has(addressKey(String(address))) ? "0x6080604052" : "0x",
      }),
      eth_call: (params) => {
        const { from = ZERO_ADDRESS, to = ZERO_ADDRESS, data, input } = callObject(params)
        return outcomeAnswer(this.#call(from, to, data ?? input ?? "0x"))
      },
      eth_estimateGas: (params) => this.#estimate(callObject(params)),
      eth_getBlockByNumber: ([tag]) => this.#block(tag),
      eth_gasPrice: () => quantity(this.gasPrice ?? (this.baseFee ?? 0n) + this.#tip()),
      eth_maxPriorityFeePerGas: () =>
        this.priorityFee === "unsupported" ? methodNotFound : quantity(this.priorityFee),
      eth_sendRawTransaction: (params) => this.#send(params),
      eth_getTransactionReceipt: ([hash]) => this.#receipt(hash),
      eth_getTransactionByHash: ([hash]) => this.#transactionByHash(hash),
      linea_estimateGas: () => {
        if (!this.linea) return methodNotFound
        const { gasLimit, baseFeePerGas, priorityFeePerGas } = this.linea
        return {
          result: {
            gasLimit: quantityHex(gasLimit),
            baseFeePerGas: quantityHex(baseFeePerGas),
            priorityFeePerGas: quantityHex(priorityFeePerGas),
          },
        }
      },
    }
  }

  #tip(): bigint {
    return this.priorityFee === "unsupported" ? GWEI / 10n : this.priorityFee
  }
}

function isBump(old: FakeTx, replacement: FakeTx): boolean {
  const raises = (before: bigint, after: bigint) => after * 100n >= before * REPLACEMENT_PERCENT
  return (
    raises(old.maxFeePerGas, replacement.maxFeePerGas) &&
    raises(old.maxPriorityFeePerGas, replacement.maxPriorityFeePerGas)
  )
}
