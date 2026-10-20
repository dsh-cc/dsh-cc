/** Recognize two non-empty logical records without splitting quoted fields. */
export function isDelimitedData(text: string, delimiter: ',' | '\t'): boolean {
  const counts: number[] = []
  let fields = 1
  let quoted = false
  let fieldStart = true
  let closedQuote = false
  let nonEmpty = false
  const finishRecord = () => {
    if (nonEmpty) counts.push(fields)
    fields = 1
    fieldStart = true
    closedQuote = false
    nonEmpty = false
  }
  for (let i = 0; i < text.length && counts.length < 2; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') i++
        else { quoted = false; closedQuote = true }
      }
      continue
    }
    if (char === delimiter) {
      fields++
      fieldStart = true
      closedQuote = false
      nonEmpty = true
    } else if (char === '\n' || char === '\r') {
      finishRecord()
      if (char === '\r' && text[i + 1] === '\n') i++
    } else {
      // A closing quote must be followed by a delimiter, record end or EOF.
      if (closedQuote) return false
      if (char === '"') {
        if (!fieldStart) return false
        quoted = true
      }
      fieldStart = false
      if (char.trim().length > 0) nonEmpty = true
    }
  }
  if (counts.length < 2) {
    if (quoted) return false
    finishRecord()
  }
  return counts.length === 2 && counts[0]! >= 2 && counts[0] === counts[1]
}
