import { describe, expect, test } from "bun:test"
import { toolError } from "../rpc/client.fixtures"
import { addressWord, word } from "./abi"
import {
  erc1155SafeTransferFrom,
  erc20Approve,
  erc20Transfer,
  erc721SafeTransferFrom,
  setApprovalForAll,
} from "./calls"
import { balanceOfCall } from "./views"
import { FakeEvmChain, selectorOf } from "./testing"
import { EXAMPLE_REQUEST, HARDHAT_ADDRESS_0, signWithHardhat } from "./testing.sign"

const ME = HARDHAT_ADDRESS_0
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
const OPERATOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const TOKEN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
const ERC721_ID = "0x80ac58cd"

const funded = () => new FakeEvmChain("base").setBalance(ME, 10n ** 18n)

/** Sends `data` to `to` from the first Hardhat account and mines it. */
async function mineCall(fake: FakeEvmChain, to: string, data: string) {
  const { raw } = await signWithHardhat({
    ...EXAMPLE_REQUEST,
    to,
    value: 0n,
    data,
    nonce: fake.nonceOf(ME),
    gasLimit: 100_000n,
  })
  await fake.client().call("eth_sendRawTransaction", [raw])
  return fake.mine()[0]
}

const view = (fake: FakeEvmChain, to: string, data: string) =>
  fake.client().call<string>("eth_call", [{ to, data }, "latest"])

describe("an ERC-20 in the fake", () => {
  test("answers its views as a token does", async () => {
    const fake = funded()
    fake.addErc20(TOKEN_ADDRESS, {
      decimals: 6,
      symbol: "USDC",
      balances: { [ME]: 77n },
      allowances: { [ME]: { [BOB]: 9n } },
    })
    expect(await view(fake, TOKEN_ADDRESS, "0x313ce567")).toBe(`0x${word(6n)}`)
    expect(await view(fake, TOKEN_ADDRESS, balanceOfCall(ME))).toBe(`0x${word(77n)}`)
    expect(await view(fake, TOKEN_ADDRESS, `0xdd62ed3e${addressWord(ME)}${addressWord(BOB)}`)).toBe(`0x${word(9n)}`)
    expect(await view(fake, TOKEN_ADDRESS, "0x95d89b41")).toBe(`0x${word(32n)}${word(4n)}${"55534443".padEnd(64, "0")}`)
  })

  test("a function it does not have reverts without a reason", async () => {
    const fake = funded()
    fake.addErc20(TOKEN_ADDRESS)
    const error = await toolError(view(fake, TOKEN_ADDRESS, "0x12345678"))
    expect(error.message).toContain("execution reverted")
  })

  test("a mined transfer moves tokens whether it returns true or nothing", async () => {
    for (const transfer of ["true", "nothing"] as const) {
      const fake = funded()
      const token = fake.addErc20(TOKEN_ADDRESS, { balances: { [ME]: 100n }, transfer })
      expect((await mineCall(fake, TOKEN_ADDRESS, erc20Transfer(BOB, 40n))).status).toBe(1)
      expect(token.balances.get(ME.toLowerCase())).toBe(60n)
      expect(token.balances.get(BOB.toLowerCase())).toBe(40n)
    }
  })

  test("a transfer that returns false mines but moves nothing, and a reverting one fails", async () => {
    const lying = funded()
    const token = lying.addErc20(TOKEN_ADDRESS, { balances: { [ME]: 100n }, transfer: "false" })
    expect((await mineCall(lying, TOKEN_ADDRESS, erc20Transfer(BOB, 40n))).status).toBe(1)
    expect(token.balances.get(ME.toLowerCase())).toBe(100n)

    const reverting = funded()
    reverting.addErc20(TOKEN_ADDRESS, { balances: { [ME]: 100n }, transfer: "revert" })
    expect((await mineCall(reverting, TOKEN_ADDRESS, erc20Transfer(BOB, 40n))).status).toBe(0)
  })

  test("more than the balance reverts when mined, and the fee is still charged", async () => {
    const fake = funded()
    const token = fake.addErc20(TOKEN_ADDRESS, { balances: { [ME]: 5n } })
    const receipt = await mineCall(fake, TOKEN_ADDRESS, erc20Transfer(BOB, 6n))
    expect(receipt.status).toBe(0)
    expect(token.balances.get(ME.toLowerCase())).toBe(5n)
    expect(fake.balanceOf(ME)).toBe(10n ** 18n - 65_000n * receipt.effectiveGasPrice)
  })

  test("approve sets an allowance, and approve with 0 revokes it", async () => {
    const fake = funded()
    const token = fake.addErc20(TOKEN_ADDRESS, { allowances: { [ME]: { [BOB]: 50n } } })
    await mineCall(fake, TOKEN_ADDRESS, erc20Approve(BOB, 0n))
    expect(token.allowances.get(`${ME.toLowerCase()}:${BOB.toLowerCase()}`)).toBe(0n)
    await mineCall(fake, TOKEN_ADDRESS, erc20Approve(BOB, 7n))
    expect(await view(fake, TOKEN_ADDRESS, `0xdd62ed3e${addressWord(ME)}${addressWord(BOB)}`)).toBe(`0x${word(7n)}`)
  })
})

describe("an ERC-721 in the fake", () => {
  test("answers ownerOf, balanceOf and supportsInterface", async () => {
    const fake = funded()
    fake.addErc721(TOKEN_ADDRESS, { owners: { "7": ME, "8": ME }, interfaces: [ERC721_ID] })
    expect(await view(fake, TOKEN_ADDRESS, `0x6352211e${word(7n)}`)).toBe(`0x${addressWord(ME)}`)
    expect(await view(fake, TOKEN_ADDRESS, balanceOfCall(ME))).toBe(`0x${word(2n)}`)
    expect(await view(fake, TOKEN_ADDRESS, `0x01ffc9a7${ERC721_ID.slice(2)}${"0".repeat(56)}`)).toBe(`0x${word(1n)}`)
    expect(await view(fake, TOKEN_ADDRESS, `0x01ffc9a7d9b67a26${"0".repeat(56)}`)).toBe(`0x${word(0n)}`)
    expect((await toolError(view(fake, TOKEN_ADDRESS, `0x6352211e${word(99n)}`))).message).toContain("invalid token ID")
  })

  test("the owner's safeTransferFrom moves the token; another account's reverts", async () => {
    const fake = funded()
    const collection = fake.addErc721(TOKEN_ADDRESS, { owners: { "7": ME, "9": BOB } })
    expect((await mineCall(fake, TOKEN_ADDRESS, erc721SafeTransferFrom(ME, BOB, 7n))).status).toBe(1)
    expect(collection.owners.get(7n)).toBe(BOB.toLowerCase())
    expect((await mineCall(fake, TOKEN_ADDRESS, erc721SafeTransferFrom(BOB, ME, 9n))).status).toBe(0)
    expect(collection.owners.get(9n)).toBe(BOB.toLowerCase())
  })

  test("setApprovalForAll adds and removes an operator, and an operator may transfer", async () => {
    const fake = funded()
    const collection = fake.addErc721(TOKEN_ADDRESS, { owners: { "7": OPERATOR }, operators: [[OPERATOR, ME]] })
    const isApproved = `0xe985e9c5${addressWord(OPERATOR)}${addressWord(ME)}`
    expect(await view(fake, TOKEN_ADDRESS, isApproved)).toBe(`0x${word(1n)}`)
    expect((await mineCall(fake, TOKEN_ADDRESS, erc721SafeTransferFrom(OPERATOR, BOB, 7n))).status).toBe(1)
    await mineCall(fake, TOKEN_ADDRESS, setApprovalForAll(BOB, true))
    expect(collection.operators.has(`${ME.toLowerCase()}:${BOB.toLowerCase()}`)).toBe(true)
    await mineCall(fake, TOKEN_ADDRESS, setApprovalForAll(BOB, false))
    expect(collection.operators.has(`${ME.toLowerCase()}:${BOB.toLowerCase()}`)).toBe(false)
  })
})

describe("an ERC-1155 in the fake", () => {
  test("answers balanceOf and moves a count with safeTransferFrom, refusing more than is held", async () => {
    const fake = funded()
    const collection = fake.addErc1155(TOKEN_ADDRESS, { balances: [[ME, 5n, 10n]] })
    expect(await view(fake, TOKEN_ADDRESS, `0x00fdd58e${addressWord(ME)}${word(5n)}`)).toBe(`0x${word(10n)}`)
    expect((await mineCall(fake, TOKEN_ADDRESS, erc1155SafeTransferFrom(ME, BOB, 5n, 4n))).status).toBe(1)
    expect(collection.balances.get(`${ME.toLowerCase()}:5`)).toBe(6n)
    expect(collection.balances.get(`${BOB.toLowerCase()}:5`)).toBe(4n)
    expect((await mineCall(fake, TOKEN_ADDRESS, erc1155SafeTransferFrom(ME, BOB, 5n, 7n))).status).toBe(0)
    expect(collection.balances.get(`${ME.toLowerCase()}:5`)).toBe(6n)
  })

  test("an operator approved with setApprovalForAll may move another's tokens", async () => {
    const fake = funded()
    fake.addErc1155(TOKEN_ADDRESS, { balances: [[BOB, 1n, 3n]] })
    expect((await mineCall(fake, TOKEN_ADDRESS, erc1155SafeTransferFrom(BOB, ME, 1n, 1n))).status).toBe(0)
    fake.addErc1155(TOKEN_ADDRESS, { balances: [[BOB, 1n, 3n]], operators: [[BOB, ME]] })
    expect((await mineCall(fake, TOKEN_ADDRESS, erc1155SafeTransferFrom(BOB, ME, 1n, 1n))).status).toBe(1)
  })
})

describe("estimating gas on the fake", () => {
  const estimate = (fake: FakeEvmChain, to: string, data: string, value = "0x0") =>
    fake.client().call<string>("eth_estimateGas", [{ from: ME, to, data, value }])

  test("is 21000 for a plain transfer to an account and the configured gas for a contract call", async () => {
    const fake = funded()
    fake.addErc20(TOKEN_ADDRESS, { balances: { [ME]: 10n } })
    expect(await estimate(fake, BOB, "0x", "0x1")).toBe("0x5208")
    expect(await estimate(fake, TOKEN_ADDRESS, erc20Transfer(BOB, 1n))).toBe("0xfde8")
    fake.contractGas = 90_000n
    expect(await estimate(fake, TOKEN_ADDRESS, erc20Transfer(BOB, 1n))).toBe("0x15f90")
  })

  test("reverts when the simulated call would fail, with the contract's reason", async () => {
    const fake = funded()
    fake.addErc20(TOKEN_ADDRESS, { balances: { [ME]: 1n } })
    const error = await toolError(estimate(fake, TOKEN_ADDRESS, erc20Transfer(BOB, 2n)))
    expect(error.message).toContain("execution reverted: ERC20: transfer amount exceeds balance")
  })

  test("reverts for a sender who cannot send the value, and whenever estimateRevert says so", async () => {
    const fake = funded()
    expect((await toolError(estimate(fake, BOB, "0x", `0x${(2n * 10n ** 18n).toString(16)}`))).message).toContain(
      "insufficient funds",
    )
    fake.estimateRevert = "paused"
    expect((await toolError(estimate(fake, BOB, "0x"))).message).toContain("execution reverted: paused")
  })

  test("a revert's data is Error(string), as a node gives it", async () => {
    const fake = funded()
    fake.estimateRevert = "no"
    const error = await toolError(estimate(fake, BOB, "0x"))
    expect(error).toMatchObject({
      rpc: { code: 3, data: `0x${selectorOf("Error(string)")}${word(32n)}${word(2n)}${"6e6f".padEnd(64, "0")}` },
    })
  })
})
