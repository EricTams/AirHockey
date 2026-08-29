import type { DialogueChoice, DialogueLine, DialogueScript } from '../modes/dialogue'

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
    out[out.length - 1] += comma
  })
  out.push('  ]')
  out.push('}')
  return out.join('\n') + '\n'
}

/**
 * The halves of a line: who is speaking, then what they say, then where the
 * conversation goes. Everything after the text is omitted when it is absent, so
 * a line nobody branches on is written exactly as it was before branching
 * existed and its diff stays one line long.
 */
function lineText(line: DialogueLine): string[] {
  const head: string[] = []
  if (line.name !== undefined) head.push(`"name": ${JSON.stringify(line.name)}`)
  if (line.face !== undefined) head.push(`"face": ${JSON.stringify(line.face)}`)

  const rows: string[] = head.length === 0 ? [] : [`{ ${head.join(', ')},`]
  const text = `"text": ${JSON.stringify(line.text)}`
  rows.push(rows.length === 0 ? `{ ${text}` : text)

  if (line.label !== undefined) rows.push(`"label": ${JSON.stringify(line.label)}`)
  if (line.goto !== undefined) rows.push(`"goto": ${JSON.stringify(line.goto)}`)
  if (line.choices?.length) {
    // One option per line, for the same reason maps keep one grid row per line:
    // rewording an option should read as a reworded option.
    rows.push('"choices": [')
    line.choices.forEach((choice, i) => {
      const comma = i === line.choices!.length - 1 ? '' : ','
      rows.push(`  ${choiceText(choice)}${comma}`)
    })
    rows.push(']')
  }

  // Commas between the parts, and the brace that closes the line.
  return rows.map((row, i) => {
    const last = i === rows.length - 1
    const opensOrCloses = row.endsWith('[') || row.endsWith(',') || row.startsWith('  ')
    if (last) return `${row} }`
    return opensOrCloses ? row : `${row},`
  })
}

function choiceText(choice: DialogueChoice): string {
  const parts = [`"text": ${JSON.stringify(choice.text)}`]
  if (choice.goto !== undefined) parts.push(`"goto": ${JSON.stringify(choice.goto)}`)
  if (choice.setFlag !== undefined) parts.push(`"setFlag": ${JSON.stringify(choice.setFlag)}`)
  if (choice.to !== undefined) parts.push(`"to": ${choice.to}`)
  return `{ ${parts.join(', ')} }`
}
