import type { PropDef, Tileset } from '../world/tileset'

/**
 * Serialise a tileset rider file.
 *
 * Same reasoning as the map and dialogue serialisers: one grid row per line, so
 * a diff of a reclassified cell shows the cell rather than the file. Reproduces
 * the shipped `terrain.json` byte for byte while it is still unclassified,
 * which is a test.
 *
 * `reviewed` is the field that matters here. It says a person has looked at the
 * importer's guesses, and nothing but the review screen may set it.
 */

export interface TilesetFile {
  id: string
  image: string
  tilePx: number
  size: [number, number]
  reviewed: boolean
  /** One character per cell, per GRID_LEGEND. Omitted when nothing is classified. */
  grid?: string[]
  props?: PropDef[]
  names?: Record<number, string>
}

export function serializeTileset(file: TilesetFile): string {
  const out: string[] = ['{']
  out.push(`  "id": ${JSON.stringify(file.id)},`)
  out.push(`  "image": ${JSON.stringify(file.image)},`)
  out.push(`  "tilePx": ${file.tilePx},`)
  out.push(`  "size": [${file.size[0]}, ${file.size[1]}],`)

  // Each optional block is built as one multi-line string, so appending the
  // separating comma is a single operation rather than a per-line special case.
  const blocks: string[] = []
  if (file.grid && file.grid.length > 0) {
    blocks.push([
      '  "grid": [',
      ...file.grid.map((row, i) => `    ${JSON.stringify(row)}${i === file.grid!.length - 1 ? '' : ','}`),
      '  ]',
    ].join('\n'))
  }
  if (file.props && file.props.length > 0) {
    const lines = ['  "props": [']
    file.props.forEach((p, i) => {
      lines.push('    {')
      lines.push(...propLines(p).map((l) => '      ' + l))
      lines.push(`    }${i === file.props!.length - 1 ? '' : ','}`)
    })
    lines.push('  ]')
    blocks.push(lines.join('\n'))
  }
  const names = Object.entries(file.names ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]))
  if (names.length > 0) {
    const lines = ['  "names": {']
    names.forEach(([k, v], i) => {
      lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)}${i === names.length - 1 ? '' : ','}`)
    })
    lines.push('  }')
    blocks.push(lines.join('\n'))
  }

  // `reviewed` last of the scalars, so the blocks below it read as the thing
  // that was reviewed.
  out.push(`  "reviewed": ${file.reviewed}${blocks.length > 0 ? ',' : ''}`)
  blocks.forEach((block, i) => out.push(block + (i === blocks.length - 1 ? '' : ',')))

  out.push('}')
  return out.join('\n') + '\n'
}

function propLines(p: PropDef): string[] {
  const lines = [
    `"id": ${JSON.stringify(p.id)},`,
    `"name": ${JSON.stringify(p.name)},`,
    `"col": ${p.col}, "row": ${p.row},`,
    `"w": ${p.w}, "h": ${p.h},`,
    `"anchor": [${p.anchor[0]}, ${p.anchor[1]}],`,
    `"solid": ${p.solid}`,
  ]
  return lines
}

/** The file form of a tileset in memory, plus whatever the review changed. */
export function toFile(
  tileset: Tileset,
  overrides: Partial<Pick<TilesetFile, 'reviewed' | 'grid' | 'props' | 'names'>> = {},
): TilesetFile {
  return {
    id: tileset.id,
    image: tileset.image,
    tilePx: tileset.tilePx,
    size: [tileset.sheetW, tileset.sheetH],
    reviewed: overrides.reviewed ?? tileset.reviewed,
    grid: overrides.grid,
    props: overrides.props ?? [...tileset.props],
    names: overrides.names ?? { ...tileset.names },
  }
}
