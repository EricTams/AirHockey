#!/usr/bin/env node
/**
 * Local file server for the in-game level editor.
 *
 * There is deliberately no authentication. The editor is opened from a web
 * page — possibly the published GitHub Pages build — so pinning an origin
 * would break the very flow this exists for, and a token was judged more
 * friction than the contents are worth: this folder holds game data destined
 * to be published anyway.
 *
 * That trade is only sound because the reachable surface is kept tiny, so the
 * worst a stray web page can do is leave junk in a folder created for this
 * purpose:
 *
 *   - binds 127.0.0.1 only, never a routable interface;
 *   - writes only inside ./airhockey-content, which it creates itself. There
 *     is no flag to aim it somewhere else, so it cannot be pointed at a
 *     checkout or a home directory;
 *   - allows only .json and .png;
 *   - confinement is checked after realpath, so a symlink cannot escape;
 *   - never deletes, executes, or lists anything above that folder.
 *
 * Usage: npm run editor
 */
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { mkdirSync, existsSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'

/**
 * The content folder this server writes into.
 *
 * Deliberately not a checkout of the game, and deliberately not configurable.
 * A designer downloads this one file and runs it; there is no clone, no npm,
 * no repository. The folder starts empty and fills up with exactly the files
 * they edit, using the same project-relative paths the game already fetches
 * content by, so the result drops straight into public/ when it is time to
 * fold the work in.
 *
 * Since nothing authenticates, this fixed location is what bounds the damage
 * a stray web page could do. A --dir flag would hand that bound away.
 */
const ROOT = path.join(process.cwd(), 'airhockey-content')
/** The content folder is the only tree readable or writable, nothing above it. */
const ROOTS = [ROOT]
/** Extensions the editor has any business writing. */
const WRITABLE = new Set(['.json', '.png'])
const MAX_BODY = 16 * 1024 * 1024

mkdirSync(ROOT, { recursive: true })

// Deliberately not 5174: that is the port Vite falls back to when 5173 is
// taken, so a dev server and this would fight over it.
const PORT = Number(process.env.EDITOR_PORT ?? 5178)

/** Where the published game lives. The shortcut opens this. */
const SITE_URL = process.env.EDITOR_SITE || 'https://erictams.github.io/AirHockey/'

/** Remembers a "no thanks" so the shortcut offer is made once, not every run. */
const PREFS = path.join(ROOT, '.editor-prefs.json')

/**
 * Offer to drop a one-click launcher on the desktop.
 *
 * Deliberately asked here, in this terminal, and never exposed as an HTTP
 * route. Nothing authenticates this server, so a route that writes an
 * executable outside the content folder would let any web page the designer
 * has open put one on their desktop. A prompt only the person at the keyboard
 * can answer costs a keystroke and closes that off entirely.
 *
 * Writing it locally also beats offering it as a browser download: on macOS a
 * downloaded .command arrives without the execute bit and carries Gatekeeper's
 * quarantine flag, so double-clicking it fails.
 */
function desktopDir() {
  const home = os.homedir()
  // OneDrive redirects Desktop on many Windows installs; prefer the real one.
  const candidates = process.platform === 'win32'
    ? [path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'Desktop')]
    : [path.join(home, 'Desktop')]
  return candidates.find((d) => existsSync(d))
}

function shortcutName() {
  if (process.platform === 'win32') return 'AirHockey Editor.bat'
  if (process.platform === 'darwin') return 'AirHockey Editor.command'
  return 'AirHockey Editor.sh'
}

/**
 * The launcher pins the working directory to wherever the helper is running
 * now, so the content folder stays put. Without that, a double-clicked
 * shortcut would start in the home directory and the designer's work would
 * appear to have vanished.
 */
function launcherBody() {
  const script = process.argv[1] ?? ''
  const cwd = process.cwd()
  if (process.platform === 'win32') {
    return [
      '@echo off',
      'title AirHockey Editor',
      `cd /d "${cwd}" || exit /b 1`,
      `start "" "${SITE_URL}"`,
      `node "${script}"`,
      'pause',
      '',
    ].join('\r\n')
  }
  const open = process.platform === 'darwin' ? 'open' : 'xdg-open'
  return [
    '#!/bin/sh',
    `cd "${cwd}" || exit 1`,
    `${open} "${SITE_URL}" >/dev/null 2>&1 &`,
    `exec node "${script}"`,
    '',
  ].join('\n')
}

function readPrefs() {
  try { return JSON.parse(readFileSync(PREFS, 'utf8')) } catch { return {} }
}

async function offerShortcut() {
  const desktop = desktopDir()
  if (!desktop) return
  const target = path.join(desktop, shortcutName())
  if (existsSync(target)) return                 // already has one
  if (readPrefs().shortcutDeclined) return       // already said no
  // Piped or launched by the shortcut itself: no one is there to answer.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((resolve) => {
    rl.question(`  Put a "${shortcutName()}" shortcut on your desktop, so next time
  you can start all this with one double-click? [y/N] `, resolve)
  })
  rl.close()

  if (!/^y(es)?$/i.test(answer.trim())) {
    try { writeFileSync(PREFS, JSON.stringify({ shortcutDeclined: true }, null, 2) + '\n') } catch { /* not worth failing over */ }
    console.log('  No shortcut. Delete .editor-prefs.json in the content folder to be asked again.\n')
    return
  }

  try {
    writeFileSync(target, launcherBody())
    if (process.platform !== 'win32') chmodSync(target, 0o755)
    console.log(`  Created ${target}
  Double-click it to open the game and start this helper together.\n`)
  } catch (err) {
    console.log(`  Could not create the shortcut: ${err.message}\n`)
  }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

/** Resolve a project-relative path, refusing anything outside the roots. */
async function resolveSafe(rel, { forWrite = false } = {}) {
  // '' addresses the content folder itself, which is what a fresh listing wants.
  if (typeof rel !== 'string') throw new HttpError(400, 'missing "path"')
  if (rel.includes('\0')) throw new HttpError(400, 'invalid path')
  const abs = path.resolve(ROOT, rel.replace(/^\/+/, ''))

  // Resolve the nearest existing ancestor, then re-append the components that
  // do not exist yet. Resolving must not be undone by the re-append, or a
  // symlinked directory becomes a way to write anywhere on the disk.
  let probe = abs
  const missing = []
  let real = abs
  for (;;) {
    try {
      real = path.join(await fs.realpath(probe), ...missing.reverse())
      break
    } catch {
      const up = path.dirname(probe)
      if (up === probe) { real = abs; break }
      missing.push(path.basename(probe))
      probe = up
    }
  }

  const inside = ROOTS.some((r) => real === r || real.startsWith(r + path.sep))
  if (!inside) {
    throw new HttpError(403, `path escapes the content folder (${path.basename(ROOT)})`)
  }
  if (forWrite && !WRITABLE.has(path.extname(real).toLowerCase())) {
    throw new HttpError(403, `refusing to write ${path.extname(real) || 'an extensionless file'}; allowed: ${[...WRITABLE].join(', ')}`)
  }
  return real
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const CONTENT_TYPE = { '.json': 'application/json', '.png': 'image/png' }

async function handle(req, res, url) {
  const route = url.pathname

  if (route === '/api/health') {
    // How the editor decides whether to offer editing at all.
    return { ok: true, service: 'airhockey-editor', folder: path.basename(ROOT) }
  }

  if (route === '/api/list' && req.method === 'GET') {
    const dir = await resolveSafe(url.searchParams.get('path') ?? '')
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      // An un-created subfolder is empty, not an error.
    }
    return {
      path: path.relative(ROOT, dir),
      entries: entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
    }
  }

  if (route === '/api/file' && req.method === 'GET') {
    const file = await resolveSafe(url.searchParams.get('path') ?? '')
    let body
    try {
      body = await fs.readFile(file)
    } catch {
      // Not edited yet. The editor treats this as "use the shipped copy".
      throw new HttpError(404, 'not saved in this content folder')
    }
    res.writeHead(200, {
      ...corsHeaders(),
      'content-type': CONTENT_TYPE[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
    return undefined
  }

  if (route === '/api/file' && (req.method === 'PUT' || req.method === 'POST')) {
    const file = await resolveSafe(url.searchParams.get('path') ?? '', { forWrite: true })
    const body = await readBody(req)
    if (path.extname(file).toLowerCase() === '.json') {
      // Refuse to persist a file the game would then fail to load.
      try { JSON.parse(body.toString('utf8')) } catch (e) {
        throw new HttpError(400, `not valid JSON: ${e.message}`)
      }
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body)
    const rel = path.relative(ROOT, file)
    console.log(`  wrote ${rel} (${body.length} bytes)`)
    return { ok: true, path: rel, bytes: body.length }
  }

  throw new HttpError(404, `no route ${req.method} ${route}`)
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    // The published site is https and this is http on loopback. Chrome treats
    // 127.0.0.1 as trustworthy so that is not mixed content, but a page on the
    // public internet reaching a loopback address is Private Network Access,
    // and versions that enforce it want this on the preflight or they refuse.
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '86400',
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }
  try {
    const result = await handle(req, res, url)
    if (result === undefined) return          // handler already responded
    res.writeHead(200, { ...corsHeaders(), 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(result))
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (status >= 500) console.error(err)
    res.writeHead(status, { ...corsHeaders(), 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  AirHockey level editor

  saving into   ${ROOT}
  listening     http://127.0.0.1:${PORT}   (localhost only)

  Go back to the game and press Edit.
  Leave this window open while you work.
`)
  void offerShortcut()
})
