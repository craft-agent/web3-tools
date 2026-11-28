import { bytesToHex } from "@noble/curves/utils.js"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { abiString, bytesOfHex, readWord, word, WORD_BYTES } from "./abi"

/** The selector of `signature` (8 hex digits), computed here so the fake agrees with Solidity and not with the code it tests. */
export function selectorOf(signature: string): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4))
}

const SELECTOR_BYTES = 4

/** The 4-byte `Error(string)` selector a revert's data starts with. */
const ERROR_SELECTOR = selectorOf("Error(string)")

/** The lower case key a map of the fake holds `address` under. */
export function addressKey(address: string): string {
  return address.toLowerCase()
}

/** What a token answers `symbol()` with: a string, `bytes32`, a revert, or any bytes (`raw`, as `0x` hex). */
export type FakeSymbol = string | { bytes32: string } | { raw: string } | "revert"

/** What a token answers `decimals()` with: a number, a revert, or any bytes (`raw`, as `0x` hex). */
export type FakeDecimals = number | "revert" | { raw: string }

/** What a token's `transfer` does: returns true, returns false (and moves nothing), returns nothing, or reverts. */
export type FakeTransfer = "true" | "false" | "nothing" | "revert"

/** An ERC-20 token. Maps are keyed by lower case address; allowances by `owner:spender`. */
export type FakeErc20 = {
  kind: "erc20"
  decimals: FakeDecimals
  symbol: FakeSymbol
  balances: Map<string, bigint>
  allowances: Map<string, bigint>
  transfer: FakeTransfer
}

/** An ERC-721 token contract. `owners` is by token id, `operators` holds `owner:operator`, `interfaces` the 4-byte ids (8 lower case hex digits) it supports. */
export type FakeErc721 = {
  kind: "erc721"
  owners: Map<bigint, string>
  operators: Set<string>
  interfaces: Set<string>
  /** What `symbol()` answers; `undefined` for a collection without one, which reverts. */
  symbol: FakeSymbol | undefined
}

/** An ERC-1155 token contract. `balances` is keyed `owner:id`; `operators` and `interfaces` as for ERC-721. */
export type FakeErc1155 = {
  kind: "erc1155"
  balances: Map<string, bigint>
  operators: Set<string>
  interfaces: Set<string>
  /** What `symbol()` answers; `undefined` for a collection without one, which reverts. */
  symbol: FakeSymbol | undefined
}

/** A contract the fake gives code and nothing else: every call to it answers nothing. */
export type FakePlainContract = { kind: "plain" }

export type FakeContract = FakeErc20 | FakeErc721 | FakeErc1155 | FakePlainContract

/** An ERC-20 as a test describes it; every part is optional (18 decimals, symbol "TKN", `transfer` true). Addresses are in any case. */
export type Erc20Init = {
  decimals?: FakeDecimals
  symbol?: FakeSymbol
  balances?: Record<string, bigint>
  /** By owner, then spender. */
  allowances?: Record<string, Record<string, bigint>>
  transfer?: FakeTransfer
}

/** An ERC-721 as a test describes it. `owners` maps a token id to its owner; `operators` lists `[owner, operator]` pairs. */
export type Erc721Init = {
  owners?: Record<string, string>
  operators?: [string, string][]
  interfaces?: string[]
  symbol?: FakeSymbol
}

/** An ERC-1155 as a test describes it. `balances` lists `[owner, id, count]`. */
export type Erc1155Init = {
  balances?: [string, bigint, bigint][]
  operators?: [string, string][]
  interfaces?: string[]
  symbol?: FakeSymbol
}

/** The result of running a call on a contract: a revert with its reason, or the returned data and what the call changes when it is sent. */
export type CallOutcome = { revert: string } | { returns: string; effect?: () => void }

export function newErc20(init: Erc20Init = {}): FakeErc20 {
  const allowances = new Map<string, bigint>()
  for (const [owner, spenders] of Object.entries(init.allowances ?? {})) {
    for (const [spender, amount] of Object.entries(spenders))
      allowances.set(`${addressKey(owner)}:${addressKey(spender)}`, amount)
  }
  return {
    kind: "erc20",
    decimals: init.decimals ?? 18,
    symbol: init.symbol ?? "TKN",
    balances: new Map(Object.entries(init.balances ?? {}).map(([owner, amount]) => [addressKey(owner), amount])),
    allowances,
    transfer: init.transfer ?? "true",
  }
}

/** The 4-byte interface ids of `ids`, as 8 lower case hex digits whether given with `0x` or without. */
function interfaceIds(ids: string[] = []): Set<string> {
  return new Set(ids.map((id) => id.replace(/^0x/i, "").toLowerCase()))
}

export function newErc721(init: Erc721Init = {}): FakeErc721 {
  return {
    kind: "erc721",
    owners: new Map(Object.entries(init.owners ?? {}).map(([id, owner]) => [BigInt(id), addressKey(owner)])),
    operators: new Set(
      (init.operators ?? []).map(([owner, operator]) => `${addressKey(owner)}:${addressKey(operator)}`),
    ),
    interfaces: interfaceIds(init.interfaces),
    symbol: init.symbol,
  }
}

export function newErc1155(init: Erc1155Init = {}): FakeErc1155 {
  return {
    kind: "erc1155",
    balances: new Map((init.balances ?? []).map(([owner, id, count]) => [`${addressKey(owner)}:${id}`, count])),
    operators: new Set(
      (init.operators ?? []).map(([owner, operator]) => `${addressKey(owner)}:${addressKey(operator)}`),
    ),
    interfaces: interfaceIds(init.interfaces),
    symbol: init.symbol,
  }
}

/** The data a node gives with a revert: `Error(reason)`, or nothing for an empty reason. */
export function revertData(reason: string): string {
  return reason === "" ? "0x" : `0x${ERROR_SELECTOR}${abiString(reason).slice(2)}`
}

const TRUE = `0x${word(1n)}`
const FALSE = `0x${word(0n)}`
const NOTHING = "0x"

const boolWord = (value: boolean) => (value ? TRUE : FALSE)
const unsigned = (value: bigint) => `0x${word(value)}`
const revert = (reason = ""): CallOutcome => ({ revert: reason })
const addressOf = (value: bigint) => `0x${value.toString(16).padStart(40, "0")}`

/** One function of a contract: the head words it reads and what it does for a caller with those words. */
type Handler<C> = { words: number; run: (contract: C, caller: string, args: bigint[]) => CallOutcome }

type Table<C> = Map<string, Handler<C>>

function table<C>(functions: Record<string, (contract: C, caller: string, args: bigint[]) => CallOutcome>): Table<C> {
  const entries = Object.entries(functions).map(([signature, run]): [string, Handler<C>] => {
    const parameters = signature.slice(signature.indexOf("(") + 1, -1)
    return [selectorOf(signature), { words: parameters === "" ? 0 : parameters.split(",").length, run }]
  })
  return new Map(entries)
}

function symbolAnswer(symbol: FakeSymbol): CallOutcome {
  if (symbol === "revert") return revert()
  if (typeof symbol === "string") return { returns: abiString(symbol) }
  if ("raw" in symbol) return { returns: symbol.raw }
  return { returns: `0x${bytesToHex(new TextEncoder().encode(symbol.bytes32)).padEnd(WORD_BYTES * 2, "0")}` }
}

function decimalsAnswer(decimals: FakeDecimals): CallOutcome {
  if (decimals === "revert") return revert()
  return { returns: typeof decimals === "number" ? unsigned(BigInt(decimals)) : decimals.raw }
}

function interfaceTable<C extends FakeErc721 | FakeErc1155>(): Record<
  string,
  (contract: C, caller: string, args: bigint[]) => CallOutcome
> {
  return {
    "symbol()": (contract) => (contract.symbol === undefined ? revert() : symbolAnswer(contract.symbol)),
    "supportsInterface(bytes4)": (contract, _caller, [id]) => ({
      returns: boolWord(contract.interfaces.has((id >> 224n).toString(16).padStart(8, "0"))),
    }),
    "isApprovedForAll(address,address)": (contract, _caller, [owner, operator]) => ({
      returns: boolWord(contract.operators.has(`${addressOf(owner)}:${addressOf(operator)}`)),
    }),
    "setApprovalForAll(address,bool)": (contract, caller, [operator, approved]) => ({
      returns: NOTHING,
      effect: () => {
        const pair = `${addressKey(caller)}:${addressOf(operator)}`
        if (approved === 0n) contract.operators.delete(pair)
        else contract.operators.add(pair)
      },
    }),
  }
}

function approvedFor(contract: FakeErc721 | FakeErc1155, owner: string, caller: string): boolean {
  return owner === addressKey(caller) || contract.operators.has(`${owner}:${addressKey(caller)}`)
}

const ERC20: Table<FakeErc20> = table<FakeErc20>({
  "decimals()": (token) => decimalsAnswer(token.decimals),
  "symbol()": (token) => symbolAnswer(token.symbol),
  "balanceOf(address)": (token, _caller, [owner]) => ({
    returns: unsigned(token.balances.get(addressOf(owner)) ?? 0n),
  }),
  "allowance(address,address)": (token, _caller, [owner, spender]) => ({
    returns: unsigned(token.allowances.get(`${addressOf(owner)}:${addressOf(spender)}`) ?? 0n),
  }),
  "approve(address,uint256)": (token, caller, [spender, amount]) => ({
    returns: TRUE,
    effect: () => void token.allowances.set(`${addressKey(caller)}:${addressOf(spender)}`, amount),
  }),
  "transfer(address,uint256)": (token, caller, [to, amount]) => {
    if (token.transfer === "revert") return revert("ERC20: transfer failed")
    const from = addressKey(caller)
    const balance = token.balances.get(from) ?? 0n
    if (balance < amount) return revert("ERC20: transfer amount exceeds balance")
    if (token.transfer === "false") return { returns: FALSE }
    const recipient = addressOf(to)
    return {
      returns: token.transfer === "true" ? TRUE : NOTHING,
      effect: () => {
        token.balances.set(from, balance - amount)
        token.balances.set(recipient, (token.balances.get(recipient) ?? 0n) + amount)
      },
    }
  },
})

const ERC721: Table<FakeErc721> = table<FakeErc721>({
  ...interfaceTable<FakeErc721>(),
  "ownerOf(uint256)": (nft, _caller, [id]) => {
    const owner = nft.owners.get(id)
    return owner === undefined ? revert("ERC721: invalid token ID") : { returns: unsigned(BigInt(owner)) }
  },
  "balanceOf(address)": (nft, _caller, [owner]) => ({
    returns: unsigned(BigInt([...nft.owners.values()].filter((held) => held === addressOf(owner)).length)),
  }),
  "safeTransferFrom(address,address,uint256)": (nft, caller, [from, to, id]) => {
    const owner = nft.owners.get(id)
    if (owner === undefined) return revert("ERC721: invalid token ID")
    if (owner !== addressOf(from)) return revert("ERC721: transfer from incorrect owner")
    if (!approvedFor(nft, owner, caller)) return revert("ERC721: caller is not token owner or approved")
    return { returns: NOTHING, effect: () => void nft.owners.set(id, addressOf(to)) }
  },
})

const ERC1155: Table<FakeErc1155> = table<FakeErc1155>({
  ...interfaceTable<FakeErc1155>(),
  "balanceOf(address,uint256)": (token, _caller, [owner, id]) => ({
    returns: unsigned(token.balances.get(`${addressOf(owner)}:${id}`) ?? 0n),
  }),
  "safeTransferFrom(address,address,uint256,uint256,bytes)": (token, caller, [from, to, id, count]) => {
    const owner = addressOf(from)
    if (!approvedFor(token, owner, caller)) return revert("ERC1155: caller is not token owner or approved")
    const held = token.balances.get(`${owner}:${id}`) ?? 0n
    if (held < count) return revert("ERC1155: insufficient balance for transfer")
    const recipient = `${addressOf(to)}:${id}`
    return {
      returns: NOTHING,
      effect: () => {
        token.balances.set(`${owner}:${id}`, held - count)
        token.balances.set(recipient, (token.balances.get(recipient) ?? 0n) + count)
      },
    }
  },
})

/**
 * Runs `data` as a call from `caller` on `contract`, as the EVM would for `eth_call` and for a mined transaction:
 * the functions the fixed calls and reads of this package use, with the revert reasons the standard
 * implementations give. An unknown function reverts without a reason; a plain contract answers nothing.
 */
export function runContractCall(contract: FakeContract, caller: string, data: string): CallOutcome {
  const bytes = bytesOfHex(data)
  switch (contract.kind) {
    case "plain":
      return { returns: NOTHING }
    case "erc20":
      return dispatch(ERC20, contract, caller, bytes)
    case "erc721":
      return dispatch(ERC721, contract, caller, bytes)
    case "erc1155":
      return dispatch(ERC1155, contract, caller, bytes)
  }
}

function dispatch<C>(functions: Table<C>, contract: C, caller: string, bytes: Uint8Array | undefined): CallOutcome {
  if (!bytes || bytes.length < SELECTOR_BYTES) return revert()
  const handler = functions.get(bytesToHex(bytes.subarray(0, SELECTOR_BYTES)))
  const head = bytes.subarray(SELECTOR_BYTES)
  if (!handler || head.length < handler.words * WORD_BYTES) return revert()
  return handler.run(
    contract,
    caller,
    Array.from({ length: handler.words }, (_, index) => readWord(head, index)),
  )
}
