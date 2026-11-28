/** What a prompt may show of a token's symbol. */
const PROMPT_SYMBOL = /^[A-Za-z0-9.$_-]{1,12}$/

/** `symbol` when a prompt may show it (1 to 12 letters, digits and `.$_-`), else `null`: a symbol is stranger-chosen text. */
export function promptSymbol(symbol: string | null): string | null {
  return symbol !== null && PROMPT_SYMBOL.test(symbol) ? symbol : null
}
