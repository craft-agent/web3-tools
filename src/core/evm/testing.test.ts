import { describe, expect, test } from "bun:test"
import { toolError } from "../rpc/client.fixtures"
import { FakeEvmChain } from "./testing"
import { EXAMPLE_REQUEST as REQUEST, HARDHAT_ADDRESS_0, HARDHAT_ADDRESS_1, signWithHardhat } from "./testing.sign"

const GWEI = 10n ** 9n
const ETHER = 10n ** 18n

describe("the fake chain's reads", () => {
  test("answers the chain id, the block, the fees and the accounts like a node", async () => {
    const fake = new FakeEvmChain("base").setBalance(HARDHAT_ADDRESS_0, 5n * ETHER).setNonce(HARDHAT_ADDRESS_0, 3n)
    const client = fake.client()
    expect(await client.call("eth_chainId")).toBe("0x2105")
    expect(await client.call("eth_blockNumber")).toBe("0x64")
    expect(await client.call("eth_getBalance", [HARDHAT_ADDRESS_0, "latest"])).toBe("0x4563918244f40000")
    expect(await client.call("eth_getTransactionCount", [HARDHAT_ADDRESS_0, "latest"])).toBe("0x3")
    expect(await client.call("eth_maxPriorityFeePerGas")).toBe("0x5f5e100")
    expect(await client.call("eth_gasPrice")).toBe(`0x${(GWEI + GWEI / 10n).toString(16)}`)
    expect(await client.call("eth_getBlockByNumber", ["latest", false])).toMatchObject({
      number: "0x64",
      baseFeePerGas: "0x3b9aca00",
      transactions: [],
    })
    expect(await client.call("eth_getBlockByNumber", ["0x65", false])).toBeNull()
  })

  test("answers an unknown method as a node does", async () => {
    expect((await toolError(new FakeEvmChain("base").client().call("eth_nope"))).message).toContain("Method not found")
  })

  test("takes its chain id from the table unless told otherwise, and rejects a key that is not in it", () => {
    expect(new FakeEvmChain("linea").chainId).toBe(59144)
    expect(new FakeEvmChain("linea", { chainId: 5 }).chainId).toBe(5)
    expect(() => new FakeEvmChain("nowhere")).toThrow()
  })

  test("records every request, and `inject` answers the next one of a method differently", async () => {
    const fake = new FakeEvmChain("base").setBalance(HARDHAT_ADDRESS_0, 1n)
    fake.inject("eth_getBalance", { result: "0x9" }).inject("eth_getBalance", { http: { status: 500 } })
    const client = fake.client()
    expect(await client.call("eth_getBalance", [HARDHAT_ADDRESS_0])).toBe("0x9")
    expect((await toolError(client.call("eth_getBalance", [HARDHAT_ADDRESS_0]))).code).toBe("upstream_error")
    expect(await client.call("eth_getBalance", [HARDHAT_ADDRESS_0])).toBe("0x1")
    expect(fake.requestsOf("eth_getBalance")).toHaveLength(3)
    expect(fake.requests.every((request) => request.method === "eth_getBalance")).toBe(true)
  })

  test("a method the fake does not serve for this chain is not found: priority fee and linea", async () => {
    const fake = new FakeEvmChain("base", { priorityFee: "unsupported" })
    expect((await toolError(fake.client().call("eth_maxPriorityFeePerGas"))).message).toContain("Method not found")
    expect((await toolError(fake.client().call("linea_estimateGas", [{}]))).message).toContain("Method not found")
  })
})

describe("a signed transaction through the fake", () => {
  test("is accepted into the mempool, counts as pending, and is found by its hash", async () => {
    const fake = new FakeEvmChain("base").setBalance(HARDHAT_ADDRESS_0, 5n * ETHER)
    const client = fake.client()
    const signed = await signWithHardhat(REQUEST)
    expect(await client.call("eth_sendRawTransaction", [signed.raw])).toBe(signed.hash)
    expect(fake.pending.map((tx) => tx.hash)).toEqual([signed.hash])
    expect(await client.call("eth_getTransactionCount", [HARDHAT_ADDRESS_0, "latest"])).toBe("0x0")
    expect(await client.call("eth_getTransactionCount", [HARDHAT_ADDRESS_0, "pending"])).toBe("0x1")
    expect(await client.call("eth_getTransactionReceipt", [signed.hash])).toBeNull()
    expect(await client.call("eth_getTransactionByHash", [signed.hash])).toMatchObject({
      hash: signed.hash,
      from: HARDHAT_ADDRESS_0,
      to: HARDHAT_ADDRESS_1,
      nonce: "0x0",
      value: "0xde0b6b3a7640000",
      blockNumber: null,
    })
    expect(await client.call("eth_getTransactionByHash", [`0x${"11".repeat(32)}`])).toBeNull()
  })

  test("mines: value moves, the fee is charged at the effective price, the nonce advances, the block moves on", async () => {
    const fake = new FakeEvmChain("base").setBalance(HARDHAT_ADDRESS_0, 5n * ETHER)
    const client = fake.client()
    const signed = await signWithHardhat(REQUEST)
    await client.call("eth_sendRawTransaction", [signed.raw])
    const [receipt] = fake.mine()
    const price = GWEI + GWEI
    expect(receipt).toMatchObject({
      status: 1,
      gasUsed: 21_000n,
      effectiveGasPrice: price,
      blockNumber: 101n,
      index: 0,
    })
    expect(fake.balanceOf(HARDHAT_ADDRESS_0)).toBe(4n * ETHER - 21_000n * price)
    expect(fake.balanceOf(HARDHAT_ADDRESS_1)).toBe(ETHER)
    expect(fake.nonceOf(HARDHAT_ADDRESS_0)).toBe(1n)
    expect(fake.pending).toHaveLength(0)
    const onChain = await client.call("eth_getTransactionReceipt", [signed.hash])
    expect(onChain).toMatchObject({
      transactionHash: signed.hash,
      status: "0x1",
      blockNumber: "0x65",
      from: HARDHAT_ADDRESS_0,
      gasUsed: "0x5208",
    })
    expect(await client.call("eth_getTransactionByHash", [signed.hash])).toMatchObject({ blockNumber: "0x65" })
    expect(await client.call("eth_getBlockByNumber", ["0x65", false])).toMatchObject({ transactions: [signed.hash] })
  })

  test("the effective price is the max fee when that is lower than base fee plus tip", async () => {
    const fake = new FakeEvmChain("base", { baseFee: 30n * GWEI }).setBalance(HARDHAT_ADDRESS_0, ETHER * 5n)
    await fake.client().call("eth_sendRawTransaction", [(await signWithHardhat(REQUEST)).raw])
    expect(fake.mine()[0].effectiveGasPrice).toBe(20n * GWEI)
  })

  test("a call that reverts when configured: the fee is charged and nothing else happens", async () => {
    const fake = new FakeEvmChain("base").setBalance(HARDHAT_ADDRESS_0, 5n * ETHER)
    fake.revertWhen = () => true
    await fake.client().call("eth_sendRawTransaction", [(await signWithHardhat(REQUEST)).raw])
    const [receipt] = fake.mine()
    expect(receipt.status).toBe(0)
    expect(fake.balanceOf(HARDHAT_ADDRESS_0)).toBe(5n * ETHER - 21_000n * 2n * GWEI)
    expect(fake.balanceOf(HARDHAT_ADDRESS_1)).toBe(0n)
    expect(fake.nonceOf(HARDHAT_ADDRESS_0)).toBe(1n)
  })

  test("a gas limit below what the call needs uses all its gas and fails", async () => {
    const fake = new FakeEvmChain("base").setBalance(HARDHAT_ADDRESS_0, 5n * ETHER)
    fake.addContract(HARDHAT_ADDRESS_1)
    await fake.client().call("eth_sendRawTransaction", [(await signWithHardhat({ ...REQUEST, gasLimit: 30_000n })).raw])
    expect(fake.mine()[0]).toMatchObject({ status: 0, gasUsed: 30_000n })
  })

  test("the Nth receipt request mines a block first when autoMineAfterPolls is set", async () => {
    const fake = new FakeEvmChain("base", { autoMineAfterPolls: 3 }).setBalance(HARDHAT_ADDRESS_0, 5n * ETHER)
    const client = fake.client()
    const signed = await signWithHardhat(REQUEST)
    await client.call("eth_sendRawTransaction", [signed.raw])
    expect(await client.call("eth_getTransactionReceipt", [signed.hash])).toBeNull()
    expect(await client.call("eth_getTransactionReceipt", [signed.hash])).toBeNull()
    expect(await client.call("eth_getTransactionReceipt", [signed.hash])).toMatchObject({ status: "0x1" })
    expect(fake.receiptOf(signed.hash)?.blockNumber).toBe(101n)
  })
})
