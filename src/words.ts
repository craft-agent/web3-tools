import { mergeTranslations, type Translations } from "./core"
import { EVM_TRANSLATIONS } from "./core/evm/words"
import { FACT_TRANSLATIONS } from "./core/facts"
import { SOLANA_TRANSLATIONS } from "./core/solana/words"

/** The translations of every tool's words, per language, which the native plugins use in their approval prompts. */
export const ALL_TRANSLATIONS: Translations = mergeTranslations(
  FACT_TRANSLATIONS,
  EVM_TRANSLATIONS,
  SOLANA_TRANSLATIONS,
)
