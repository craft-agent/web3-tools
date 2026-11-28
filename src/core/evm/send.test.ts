import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { annotations } from "../tool"
import { holdsKeyMaterial } from "../signer/testing"
import { web3EvmSend } from "./send"
import { cleanRigs, ETHER, GWEI, makeRig, MAX_FEE, nativeArgs, TOKEN_ADDRESS, tokenArgs } from "./send.testing"
import { HARDHAT_ADDRESS_0, HARDHAT_ADDRESS_1 } from "./testing.sign"

afterEach(cleanRigs)

describe("web3EvmSend", () => {
  test("is an administrative write of the evm toolset", () => {
    expect(web3EvmSend).toMatchObject({ id: "web3_evm_send", toolset: "evm", class: "administrative" })
    expect(annotations(web3EvmSend)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })
    expect(web3EvmSend.intent).not.toMatch(/[{}]/)
  })

  test("declares the bounds a grant can limit", () => {
    expect(Object.keys(web3EvmSend.bounds ?? {})).toEqual(["asset", "recipient", "amount", "max_fee"])
  })
})

describe("a native send", () => {
  test("moves the coin, settles the ledger row confirmed and reports what it sent", async () => {
    const rig = makeRig()
    const result = await rig.run(nativeArgs({ amount: "1.5" }))

    const [row] = await rig.rows()
    expect(result).toEqual({
      chain: "ethereum",
      hash: row!.hash,
      outcome: "confirmed",
      ledger_row: row!.id,
      from: HARDHAT_ADDRESS_0,
      to: HARDHAT_ADDRESS_1,
      ens: null,
      token: null,
      token_id: null,
      amount: "1.5",
      symbol: "ETH",
      block: "101",
      explorer: `https://etherscan.io/tx/${row!.hash}`,
    })
    expect(row).toMatchObject({
      family: "evm",
      chain: "ethereum",
      sender: HARDHAT_ADDRESS_0,
      recipient: HARDHAT_ADDRESS_1,
      kind: "native",
      token: null,
      amount: ((3n * ETHER) / 2n).toString(),
      nonce: "0",
      outcome: "confirmed",
      block: "101",
    })
    expect(rig.fake.balanceOf(HARDHAT_ADDRESS_1)).toBe((3n * ETHER) / 2n)
    expect(rig.fake.balanceOf(HARDHAT_ADDRESS_0)).toBeLessThan(10n * ETHER - (3n * ETHER) / 2n)
    expect(rig.fake.nonceOf(HARDHAT_ADDRESS_0)).toBe(1n)
    expect(rig.broadcasts()).toHaveLength(1)
  })

  test("takes the nonce the network expects next", async () => {
    const rig = makeRig()
    rig.fake.setNonce(HARDHAT_ADDRESS_0, 7n)
    await rig.run(nativeArgs())
    expect((await rig.rows())[0]).toMatchObject({ nonce: "7", outcome: "confirmed" })
  })

  test("a reverted transaction is failed, with its fee spent and nothing moved", async () => {
    const rig = makeRig()
    rig.fake.revertWhen = () => true
    const result = await rig.run(nativeArgs())
    expect(result.outcome).toBe("failed")
    expect(result.block).toBe("101")
    expect((await rig.rows())[0]).toMatchObject({ outcome: "failed", block: "101" })
    expect(rig.fake.balanceOf(HARDHAT_ADDRESS_1)).toBe(0n)
    expect(rig.fake.balanceOf(HARDHAT_ADDRESS_0)).toBeLessThan(10n * ETHER)
    expect(rig.fake.balanceOf(HARDHAT_ADDRESS_0)).toBeGreaterThan(10n * ETHER - GWEI * 21_000n * 3n)
  })
})

describe("an ERC-20 send", () => {
  test("moves the tokens and the ledger row names the token", async () => {
    const rig = makeRig()
    const result = await rig.run(tokenArgs({ amount: "2.5" }))

    expect(result).toMatchObject({
      outcome: "confirmed",
      token: TOKEN_ADDRESS,
      amount: "2.5",
      symbol: "TKN",
      to: HARDHAT_ADDRESS_1,
    })
    const token = rig.fake.contractAt(TOKEN_ADDRESS)
    if (token?.kind !== "erc20") throw new Error("no token")
    expect(token.balances.get(HARDHAT_ADDRESS_1.toLowerCase())).toBe((5n * ETHER) / 2n)
    expect(token.balances.get(HARDHAT_ADDRESS_0.toLowerCase())).toBe(1000n * ETHER - (5n * ETHER) / 2n)
    expect(rig.fake.balanceOf(HARDHAT_ADDRESS_1)).toBe(0n)
    expect((await rig.rows())[0]).toMatchObject({
      kind: "erc20",
      token: TOKEN_ADDRESS,
      amount: ((5n * ETHER) / 2n).toString(),
    })
  })

  test("works with a token whose transfer returns nothing", async () => {
    const rig = makeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, { transfer: "nothing", balances: { [HARDHAT_ADDRESS_0]: 100n * ETHER } })
    expect((await rig.run(tokenArgs())).outcome).toBe("confirmed")
  })

  test("a token without a showable symbol is reported with a null symbol", async () => {
    const rig = makeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, { symbol: "not a symbol!", balances: { [HARDHAT_ADDRESS_0]: 100n * ETHER } })
    expect((await rig.run(tokenArgs())).symbol).toBeNull()
  })
})

describe("what a send leaves behind", () => {
  test("no result, error or ledger file holds a key or the signed transaction", async () => {
    const rig = makeRig()
    const result = await rig.run(nativeArgs())
    expect(holdsKeyMaterial(result)).toBe(false)
    const raw = rig.broadcasts()[0]!
    expect(JSON.stringify(result)).not.toContain(raw)
    const file = readFileSync(`${rig.stateDir}/ledger/ledger.jsonl`, "utf8")
    expect(file).not.toContain(raw)
    expect(file).not.toContain(raw.slice(2, 60))
    expect(holdsKeyMaterial(file)).toBe(false)
  })
})

describe("asking the person", () => {
  test("asks for an administrative write with what will be sent, and goes on when the answer is yes", async () => {
    const rig = makeRig()
    const asked: string[] = []
    rig.ctx = {
      ...rig.ctx,
      confirm: async ({ tool, message }) => {
        asked.push(`${tool}: ${message}`)
        return true
      },
    }
    expect((await rig.run(nativeArgs({ amount: "1.5" }))).outcome).toBe("confirmed")
    expect(asked).toEqual([
      `web3_evm_send: Send 1.5 ETH on Ethereum from ${HARDHAT_ADDRESS_0} to ${HARDHAT_ADDRESS_1}, with a fee of at most ${MAX_FEE} wei`,
    ])
  })

  test("sends nothing and writes no row when the answer is no", async () => {
    const rig = makeRig()
    rig.ctx = { ...rig.ctx, confirm: async () => false }
    await expect(rig.run(nativeArgs())).rejects.toMatchObject({ code: "declined" })
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })

  test("sends nothing when what was asked about changed while the person answered", async () => {
    const rig = makeRig()
    rig.ctx = {
      ...rig.ctx,
      confirm: async () => {
        const token = rig.fake.contractAt(TOKEN_ADDRESS)
        if (token?.kind === "erc20") token.decimals = 6
        return true
      },
    }
    await expect(rig.invoke(tokenArgs())).rejects.toMatchObject({ code: "stale" })
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })
})
