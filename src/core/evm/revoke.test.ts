import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { holdsKeyMaterial } from "../signer/testing"
import { annotations } from "../tool"
import { ALL_TOOLS } from "../../tools"
import { web3EvmRevoke } from "./revoke"
import { makeRevokeRig, revokeArgs, SPENDER_ADDRESS, type RevokeRig } from "./revoke.testing"
import { cleanRigs, COLLECTION_ADDRESS, ERC1155_ID, ERC721_ID, TOKEN_ADDRESS } from "./send.testing"
import { HARDHAT_ADDRESS_0 } from "./testing.sign"

afterEach(cleanRigs)

const ME = HARDHAT_ADDRESS_0.toLowerCase()
const SPENDER = SPENDER_ADDRESS.toLowerCase()

/** The selectors of `approve` and `setApprovalForAll`, as the data of a transaction starts. */
const APPROVE = "0x095ea7b3"
const SET_APPROVAL_FOR_ALL = "0xa22cb465"

/** A rig whose token gives `SPENDER_ADDRESS` an allowance of 50 from `main`. */
function rigWithAllowance(): { rig: RevokeRig; allowances: Map<string, bigint> } {
  const rig = makeRevokeRig()
  const { allowances } = rig.fake.addErc20(TOKEN_ADDRESS, { allowances: { [HARDHAT_ADDRESS_0]: { [SPENDER]: 50n } } })
  return { rig, allowances }
}

describe("web3EvmRevoke", () => {
  test("is a write of the evm toolset that only lowers exposure, so its class is idempotent", () => {
    expect(web3EvmRevoke).toMatchObject({ id: "web3_evm_revoke", toolset: "evm", class: "idempotent" })
    expect(web3EvmRevoke.title).toBe("Revoke an approval")
    expect(web3EvmRevoke.intent).not.toMatch(/[{}]/)
    expect(annotations(web3EvmRevoke)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    })
  })

  test("declares the bounds a grant can limit, and is one of the package's tools", () => {
    expect(Object.keys(web3EvmRevoke.bounds ?? {})).toEqual(["asset", "max_fee"])
    expect(ALL_TOOLS).toContain(web3EvmRevoke)
  })

  test("says that an approval of one ERC-721 token is not covered", () => {
    expect(web3EvmRevoke.description).toMatch(/one ERC-721 token.*not covered/)
  })
})

describe("revoking an ERC-20 allowance", () => {
  test("sets it to 0, settles the row confirmed and reports what it revoked", async () => {
    const { rig, allowances } = rigWithAllowance()
    const result = await rig.run(revokeArgs())

    const [row] = await rig.rows()
    expect(result).toEqual({
      ens: null,
      chain: "ethereum",
      hash: row!.hash,
      outcome: "confirmed",
      ledger_row: row!.id,
      from: HARDHAT_ADDRESS_0,
      token: TOKEN_ADDRESS,
      spender: SPENDER_ADDRESS,
      revoked: "allowance",
      block: "101",
      explorer: `https://etherscan.io/tx/${row!.hash}`,
    })
    expect(row).toMatchObject({
      kind: "revoke_erc20",
      sender: HARDHAT_ADDRESS_0,
      recipient: SPENDER_ADDRESS,
      token: TOKEN_ADDRESS,
      amount: "0",
      nonce: "0",
      outcome: "confirmed",
    })
    expect(allowances.get(`${ME}:${SPENDER}`)).toBe(0n)
    expect(rig.fake.nonceOf(HARDHAT_ADDRESS_0)).toBe(1n)
  })

  test("signs approve(spender, 0), whatever the allowance was", async () => {
    const { rig } = rigWithAllowance()
    const description = await rig.approve(revokeArgs())
    expect(description.pin).toBeDefined()
    await rig.run(revokeArgs())
    const tx = rig.fake.receiptOf((await rig.rows())[0]!.hash)!.tx
    expect(tx.to.toLowerCase()).toBe(TOKEN_ADDRESS.toLowerCase())
    expect(tx.data).toBe(`${APPROVE}${SPENDER.slice(2).padStart(64, "0")}${"0".repeat(64)}`)
    expect(tx.value).toBe(0n)
  })

  test("asks no one: an idempotent write is covered by the harness's own approval", async () => {
    const { rig } = rigWithAllowance()
    const asked: string[] = []
    rig.ctx = {
      ...rig.ctx,
      confirm: async ({ message }) => {
        asked.push(message)
        return true
      },
    }
    expect((await rig.run(revokeArgs())).outcome).toBe("confirmed")
    expect(asked).toEqual([])
  })

  test("a revert on the chain is failed, with the allowance left as it was", async () => {
    const { rig, allowances } = rigWithAllowance()
    rig.fake.revertWhen = () => true
    const result = await rig.run(revokeArgs())
    expect(result.outcome).toBe("failed")
    expect(allowances.get(`${ME}:${SPENDER}`)).toBe(50n)
  })
})

describe("revoking an operator", () => {
  test("of an ERC-721 collection removes it with setApprovalForAll(operator, false)", async () => {
    const rig = makeRevokeRig()
    const { operators } = rig.fake.addErc721(COLLECTION_ADDRESS, {
      interfaces: [ERC721_ID],
      operators: [[HARDHAT_ADDRESS_0, SPENDER_ADDRESS]],
    })
    const result = await rig.run(revokeArgs({ token: COLLECTION_ADDRESS }))
    expect(result).toMatchObject({ outcome: "confirmed", revoked: "operator", token: COLLECTION_ADDRESS })
    expect(operators.size).toBe(0)
    const [row] = await rig.rows()
    expect(row).toMatchObject({
      kind: "revoke_operator",
      recipient: SPENDER_ADDRESS,
      token: COLLECTION_ADDRESS,
      amount: "0",
    })
    const tx = rig.fake.receiptOf(row!.hash)!.tx
    expect(tx.data).toBe(`${SET_APPROVAL_FOR_ALL}${SPENDER.slice(2).padStart(64, "0")}${"0".repeat(64)}`)
  })

  test("of an ERC-1155 collection too", async () => {
    const rig = makeRevokeRig()
    const { operators } = rig.fake.addErc1155(COLLECTION_ADDRESS, {
      interfaces: [ERC1155_ID],
      operators: [[HARDHAT_ADDRESS_0, SPENDER_ADDRESS]],
    })
    expect((await rig.run(revokeArgs({ token: COLLECTION_ADDRESS }))).revoked).toBe("operator")
    expect(operators.size).toBe(0)
  })

  test("a token without decimals takes the operator path and never calls approve", async () => {
    const rig = makeRevokeRig()
    rig.fake.addErc721(COLLECTION_ADDRESS, { operators: [[HARDHAT_ADDRESS_0, SPENDER_ADDRESS]] })
    await rig.run(revokeArgs({ token: COLLECTION_ADDRESS }))
    const datas = rig.fake.requestsOf("eth_call").map(([call]) => String((call as { data: string }).data))
    expect(datas.some((data) => data.startsWith("0xdd62ed3e"))).toBe(false)
    const tx = rig.fake.receiptOf((await rig.rows())[0]!.hash)!.tx
    expect(tx.data.startsWith(SET_APPROVAL_FOR_ALL)).toBe(true)
    expect(tx.data).not.toContain(APPROVE.slice(2))
  })
})

describe("what a revoke leaves behind", () => {
  test("no result, ledger row or error holds a key or the signed transaction", async () => {
    const { rig } = rigWithAllowance()
    const result = await rig.run(revokeArgs())
    expect(holdsKeyMaterial(result)).toBe(false)
    const raw = rig.broadcasts()[0]!
    expect(JSON.stringify(result)).not.toContain(raw)
    const file = readFileSync(`${rig.stateDir}/ledger/ledger.jsonl`, "utf8")
    expect(file).not.toContain(raw.slice(2, 60))
    expect(holdsKeyMaterial(file)).toBe(false)
    const error = await rig.run(revokeArgs()).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "invalid_argument" })
    expect(holdsKeyMaterial(error)).toBe(false)
    expect(String((error as Error).message)).not.toContain(raw.slice(2, 60))
  })
})
