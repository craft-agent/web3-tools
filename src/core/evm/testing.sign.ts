import { rawTransactionHex, signEvmTransaction } from "../signer/sign"
import { fakeRuntime, HARDHAT_KEY_0 } from "../signer/testing"
import type { EvmTransactionRequest } from "./transaction"

/** The address of Hardhat's first account, whose key `signWithHardhat` signs with. */
export const HARDHAT_ADDRESS_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

/** The address of Hardhat's second account. */
export const HARDHAT_ADDRESS_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

/**
 * A transfer of 1 ether from Hardhat's first account to its second on Base (chain id 8453), nonce 0, 21000 gas,
 * a max fee of 20 gwei and a tip of 1 gwei: the request the fake chain's tests start from.
 */
export const EXAMPLE_REQUEST: EvmTransactionRequest = {
  chainId: 8453,
  to: HARDHAT_ADDRESS_1,
  value: 10n ** 18n,
  data: "0x",
  nonce: 0n,
  gasLimit: 21_000n,
  maxFeePerGas: 20n * 10n ** 9n,
  maxPriorityFeePerGas: 10n ** 9n,
}

const RUNTIME = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: HARDHAT_KEY_0 })

/** The state directory of a signer that reads its key from the variable: never opened. */
const UNUSED_STATE_DIR = "/nonexistent/web3-tools-state"

/**
 * `request` signed by Hardhat's first account, as the raw transaction a node takes and its hash. Signatures are
 * hedged, so signing one request twice gives two hashes: a way to make a replacement. Test-only.
 */
export async function signWithHardhat(
  request: EvmTransactionRequest,
): Promise<{ raw: string; hash: string; from: string }> {
  const signed = await signEvmTransaction(
    { label: "main", index: null, address: HARDHAT_ADDRESS_0 },
    request,
    RUNTIME,
    UNUSED_STATE_DIR,
  )
  return { raw: rawTransactionHex(signed), hash: signed.hash, from: signed.from }
}
