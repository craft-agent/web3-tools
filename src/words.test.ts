import { describe, expect, test } from "bun:test"
import { EVM_TRANSLATIONS } from "./core/evm/words"
import { FACT_TRANSLATIONS } from "./core/facts"
import { ALL_TRANSLATIONS } from "./words"

describe("ALL_TRANSLATIONS", () => {
  test("holds the shared fact words in Japanese", () => {
    expect(ALL_TRANSLATIONS.ja).toMatchObject(FACT_TRANSLATIONS.ja!)
    expect(ALL_TRANSLATIONS.ja!.Size).toBe("サイズ")
  })

  test("holds the words of the EVM sends in Japanese", () => {
    expect(ALL_TRANSLATIONS.ja).toMatchObject(EVM_TRANSLATIONS.ja!)
    expect(ALL_TRANSLATIONS.ja!.Recipient).toBe("受取人")
  })
})
