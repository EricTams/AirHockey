import type { DialogueLine, DialogueScript } from '../modes/dialogue'

/**
 * Serialise a dialogue script the way the shipped ones are written.
 *
 * The same reasoning as `serializeMap`: the speaker and the portrait share a
 * line because they are one fact about who is talking, and the text gets its
 * own line because it is the part anyone reviewing a diff came to read. Plain
 * `JSON.stringify(script, null, 2)` splits every line of dialogue across four,
 * which makes a rewording look like a rewrite.
 *
 * Reproduces the hand-authored files byte for byte; a test holds it there.
 */
export function serializeDialogue(script: DialogueScript): string {
  const out: string[] = ['{']
  out.push(`  "id": ${JSON.stringify(script.id)},`)

  if (script.lines.length === 0) {
    // parseDialogue rejects this, but serialising is not the place to throw.
    out.push('  "lines": []')
    out.push('}')
    return out.join('\n') + '\n'
  }

  out.push('  "lines": [')
  script.lines.forEach((line, i) => {
    const comma = i === script.lines.length - 1 ? '' : ','
    out.push(...lineText(line).map((l, j) => (j === 0 ? '    ' : '      ') + l))
    out[out.length - 1] += ` }${comma}`
  })
  out.push('  ]')
  out.push('}')
  return out.join('\n') + '\n'
}

/**
 * The two halves of a line: who is speaking, then what they say. The closing
 * brace is appended by the caller, which is what keeps `"text": "…" }` on one
 * line however long the text is.
 */
function lineText(line: DialogueLine): string[] {
  const head: string[] = []
  if (line.name !== undefined) head.push(`"name": ${JSON.stringify(line.name)}`)
  if (line.face !== undefined) head.push(`"face": ${JSON.stringify(line.face)}`)
  const text = `"text": ${JSON.stringify(line.text)}`
  if (head.length === 0) return [`{ ${text}`]
  return [`{ ${head.join(', ')},`, text]
}
