import { afterEach, describe, expect, test } from "bun:test"
import { templatePlaceholders, wholeCallDescription } from "../describe"
import { resolveAccount } from "../signer/accounts"
import type { ToolSpec } from "../tool"
import { translator, type Words } from "../words"
import { makeRevokeRig, revokeArgs, SPENDER_ADDRESS } from "./revoke.testing"
import {
  cleanRigs,
  COLLECTION_ADDRESS,
  ERC1155_ID,
  ERC721_ID,
  makeRig,
  nativeArgs,
  nftArgs,
  TOKEN_ADDRESS,
  tokenArgs,
  type EvmToolRig,
} from "./send.testing"
import { HARDHAT_ADDRESS_0, HARDHAT_ADDRESS_1 } from "./testing.sign"
import { EVM_TRANSLATIONS } from "./words"

afterEach(cleanRigs)

const JA = EVM_TRANSLATIONS.ja as Words
const NO_SYMBOL = "not a symbol!"

/** Every English word and template of the prompt `args` draw: the tool's title and intent, its headline, the labels and the value templates. */
async function wordsOf<Spec extends ToolSpec>(rig: EvmToolRig<Spec>, args: unknown): Promise<string[]> {
  const description = await wholeCallDescription(rig.tool, args, rig.ctx)
  if (!description) throw new Error("no description")
  const values = description.facts.flatMap(({ value }) => (typeof value === "string" ? [] : [value.text]))
  return [
    rig.tool.title,
    rig.tool.intent ?? "",
    ...(description.headline ? [description.headline.text] : []),
    ...description.facts.map(({ label }) => label),
    ...values,
  ]
}

async function sendWords(): Promise<Set<string>> {
  const words: string[] = []
  const rig = makeRig()
  rig.fake.addEnsName("vitalik.eth", HARDHAT_ADDRESS_1)
  const own = (await resolveAccount("savings", "evm", rig.runtime, rig.stateDir)).address
  words.push(...(await wordsOf(rig, nativeArgs())))
  words.push(...(await wordsOf(rig, nativeArgs({ to: own }))))
  words.push(...(await wordsOf(rig, nativeArgs({ to: "vitalik.eth" }))))
  words.push(...(await wordsOf(rig, tokenArgs())))
  rig.fake.addErc20(TOKEN_ADDRESS, { symbol: NO_SYMBOL, balances: { [HARDHAT_ADDRESS_0]: 10n ** 20n } })
  words.push(...(await wordsOf(rig, tokenArgs())))
  rig.fake.addErc721(COLLECTION_ADDRESS, { owners: { "7": HARDHAT_ADDRESS_0 }, interfaces: [ERC721_ID], symbol: "APE" })
  words.push(...(await wordsOf(rig, nftArgs())))
  rig.fake.addErc1155(COLLECTION_ADDRESS, { balances: [[HARDHAT_ADDRESS_0, 7n, 5n]], interfaces: [ERC1155_ID] })
  words.push(...(await wordsOf(rig, nftArgs({ amount: "2" }))))
  return new Set(words)
}

async function revokeWords(): Promise<Set<string>> {
  const words: string[] = []
  const rig = makeRevokeRig()
  const spender = SPENDER_ADDRESS.toLowerCase()
  rig.fake.addEnsName("uniswap.eth", SPENDER_ADDRESS)
  rig.fake.addErc20(TOKEN_ADDRESS, { allowances: { [HARDHAT_ADDRESS_0]: { [spender]: 50n } } })
  words.push(...(await wordsOf(rig, revokeArgs())))
  words.push(...(await wordsOf(rig, revokeArgs({ spender: "uniswap.eth" }))))
  rig.fake.addErc721(COLLECTION_ADDRESS, { interfaces: [ERC721_ID], operators: [[HARDHAT_ADDRESS_0, SPENDER_ADDRESS]] })
  words.push(...(await wordsOf(rig, revokeArgs({ token: COLLECTION_ADDRESS }))))
  rig.fake.addErc721(COLLECTION_ADDRESS, {
    interfaces: [ERC721_ID],
    operators: [[HARDHAT_ADDRESS_0, SPENDER_ADDRESS]],
    symbol: "APE",
  })
  words.push(...(await wordsOf(rig, revokeArgs({ token: COLLECTION_ADDRESS }))))
  rig.fake.addErc20(TOKEN_ADDRESS, { symbol: NO_SYMBOL, allowances: { [HARDHAT_ADDRESS_0]: { [spender]: 50n } } })
  words.push(...(await wordsOf(rig, revokeArgs())))
  return new Set(words)
}

describe("the Japanese words of the send and revoke prompts", () => {
  test("every word and template either prompt can draw has a Japanese entry that keeps its placeholders", async () => {
    const english = new Set([...(await sendWords()), ...(await revokeWords())])
    expect(english.size).toBeGreaterThan(30)
    for (const text of english) {
      expect(Object.hasOwn(JA, text), text).toBe(true)
      expect(templatePlaceholders(JA[text]!), text).toEqual(templatePlaceholders(text))
    }
  })

  test("the table holds nothing the prompts no longer draw", async () => {
    const english = new Set([...(await sendWords()), ...(await revokeWords())])
    expect(Object.keys(JA).filter((text) => !english.has(text))).toEqual([])
  })

  test("a translator takes each entry as it is, none dropped for its placeholders or length", () => {
    const ja = translator(EVM_TRANSLATIONS, "ja")
    for (const [text, translation] of Object.entries(JA)) expect(ja.template(text), text).toBe(translation)
  })
})
