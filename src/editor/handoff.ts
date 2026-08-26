import type { EditorServer } from './server'
import { makeZip, type ZipEntry } from './zip'

/**
 * Getting the designer's work back.
 *
 * Their edits live in `airhockey-content/` on their own machine, with no git,
 * no checkout, and no route to the repo (handoff decisions 1 and 8). This packs
 * the folder into a zip they can send, which is then unzipped over `public/`.
 *
 * The paths inside the zip are the same project-relative paths the game fetches
 * by and the helper writes by — `data/maps/overworld.json` — so unzipping over
 * `public/` lands every file exactly where the game already looks for it.
 */

export interface Bundle {
  filename: string
  bytes: Uint8Array
  /** Content paths included, for telling the designer what they are sending. */
  paths: string[]
}

/** Read the whole content folder and pack it. */
export async function bundleChanges(
  server: EditorServer, now = new Date(),
): Promise<Bundle> {
  const paths = [...(await server.buildIndex())].sort()
  const files = await Promise.all(
    paths.map(async (path): Promise<ZipEntry> => ({ path, data: await server.readBytes(path) })),
  )

  const entries: ZipEntry[] = [
    ...files,
    { path: 'README.txt', data: new TextEncoder().encode(readme(paths, now)) },
  ]

  return {
    filename: `airhockey-content-${stamp(now)}.zip`,
    bytes: makeZip(entries, now),
    paths,
  }
}

/**
 * Hand the file to the browser.
 *
 * Kept apart from `bundleChanges` so the packing is testable without a DOM;
 * this half is three lines that only a browser can run.
 */
export function saveBundle(bundle: Bundle): void {
  const url = URL.createObjectURL(new Blob([bundle.bytes as BlobPart], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = bundle.filename
  a.click()
  // Revoking immediately can race the download on some browsers; a tick is
  // enough, and the object is small.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function stamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function readme(paths: readonly string[], now: Date): string {
  const list = paths.length > 0 ? paths.map((p) => `  ${p}`).join('\n') : '  (nothing yet)'
  return [
    'AirHockey — level editor changes',
    `Exported ${now.toISOString()}`,
    '',
    'These are the files edited in the level editor. The paths are the same',
    'ones the game loads by, so they go straight into the repo:',
    '',
    '  unzip -o airhockey-content-*.zip -d /path/to/AirHockey/public',
    '',
    'then delete the README and commit. Nothing here needs converting, and the',
    'game validates every one of these files strictly on load, so a bad export',
    'fails at startup rather than half-drawing a world.',
    '',
    'Files:',
    list,
    '',
  ].join('\n')
}
