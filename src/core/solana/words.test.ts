import { afterEach, describe, expect, test } from "bun:test"
import { templatePlaceholders, wholeCallDescription } from "../describe"
import { EVM_TRANSLATIONS } from "../evm/words"
import { resolveAccount } from "../signer/accounts"
import { mergeTranslations, translator, type Words } from "../words"
import { BOB, cleanRigs, makeRig, MINT, solArgs, tokenArgs, type SendRig } from "./send.testing"
import { testAddress } from "./testing"
import { SOLANA_TRANSLATIONS } from "./words"

afterEach(cleanRigs)

const JA = SOLANA_TRANSLATIONS.ja as Words
const SHARED = mergeTranslations(EVM_TRANSLATIONS, SOLANA_TRANSLATIONS)
const SHARED_JA = SHARED.ja as Words

/** Every English word and template of the prompt `args` draw: the tool's title and intent, its headline, the labels and the value templates. */
async function wordsOf(rig: SendRig, args: unknown): Promise<string[]> {
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
  const rig = makeRig()
  const own = (await resolveAccount("savings", "solana", rig.runtime, rig.stateDir)).address
  const words = [
    ...(await wordsOf(rig, solArgs())),
    ...(await wordsOf(rig, solArgs({ to: own }))),
    ...(await wordsOf(rig, tokenArgs())),
  ]
  rig.fake.addMint(MINT, {
    decimals: 6,
    extensions: [{ extension: "permanentDelegate", state: { delegate: testAddress(9) } }],
  })
  words.push(...(await wordsOf(rig, tokenArgs())))
  rig.fake.addAssociatedTokenAccount(BOB, MINT)
  rig.fake.addMetadata({ mint: MINT, symbol: "not a symbol!", tokenStandard: null })
  words.push(...(await wordsOf(rig, tokenArgs())))
  return new Set(words)
}

describe("the Japanese words of the Solana send prompt", () => {
  test("every word and template the prompt can draw has a Japanese entry, in the EVM table or this one, that keeps its placeholders", async () => {
    const english = await sendWords()
    expect(english.size).toBeGreaterThan(12)
    for (const text of english) {
      expect(Object.hasOwn(SHARED_JA, text), text).toBe(true)
      expect(templatePlaceholders(SHARED_JA[text]!), text).toEqual(templatePlaceholders(text))
    }
  })

  test("this table holds only what the prompt draws and the EVM table does not already have", async () => {
    const english = await sendWords()
    const evm = EVM_TRANSLATIONS.ja as Words
    expect(Object.keys(JA).filter((text) => !english.has(text) || Object.hasOwn(evm, text))).toEqual([])
  })

  test("a translator takes each entry as it is, none dropped for its placeholders or length", () => {
    const ja = translator(SOLANA_TRANSLATIONS, "ja")
    for (const [text, translation] of Object.entries(JA)) expect(ja.template(text), text).toBe(translation)
  })
})
