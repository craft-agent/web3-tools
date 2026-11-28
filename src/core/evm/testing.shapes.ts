import { bytesToHex } from "@noble/curves/utils.js"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { quantityHex } from "./abi"

/** A transaction the fake holds or has mined. `from` is the library's (checksummed) address of the signer. */
export type FakeTx = {
  hash: string
  from: string
  nonce: bigint
  to: string
  value: bigint
  data: string
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/** The outcome of a mined transaction. */
export type FakeReceipt = {
  tx: FakeTx
  blockNumber: bigint
  index: number
  /** 1 for success; 0 for a revert or an out-of-gas, with the fee charged and no effect. */
  status: 0 | 1
  gasUsed: bigint
  effectiveGasPrice: bigint
}

/** The hash of block `number`: made from the number alone, so it is the same in every run. */
export function blockHashOf(number: bigint): string {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(`block ${number}`)))}`
}

/** `tx` as `eth_getTransactionByHash` answers it; the block fields are null until it is mined. */
export function transactionObject(tx: FakeTx, chainId: number, receipt?: FakeReceipt): Record<string, unknown> {
  return {
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    nonce: quantityHex(tx.nonce),
    value: quantityHex(tx.value),
    input: tx.data,
    gas: quantityHex(tx.gasLimit),
    maxFeePerGas: quantityHex(tx.maxFeePerGas),
    maxPriorityFeePerGas: quantityHex(tx.maxPriorityFeePerGas),
    type: "0x2",
    chainId: quantityHex(BigInt(chainId)),
    accessList: [],
    blockNumber: receipt ? quantityHex(receipt.blockNumber) : null,
    blockHash: receipt ? blockHashOf(receipt.blockNumber) : null,
    transactionIndex: receipt ? quantityHex(BigInt(receipt.index)) : null,
  }
}

/** `receipt` as `eth_getTransactionReceipt` answers it. */
export function receiptObject(receipt: FakeReceipt): Record<string, unknown> {
  const { tx } = receipt
  return {
    transactionHash: tx.hash,
    transactionIndex: quantityHex(BigInt(receipt.index)),
    blockHash: blockHashOf(receipt.blockNumber),
    blockNumber: quantityHex(receipt.blockNumber),
    from: tx.from,
    to: tx.to,
    status: receipt.status === 1 ? "0x1" : "0x0",
    gasUsed: quantityHex(receipt.gasUsed),
    cumulativeGasUsed: quantityHex(receipt.gasUsed),
    effectiveGasPrice: quantityHex(receipt.effectiveGasPrice),
    type: "0x2",
    contractAddress: null,
    logs: [],
    logsBloom: `0x${"0".repeat(512)}`,
  }
}
