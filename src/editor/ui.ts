import { EditorServer, serverDownloadUrl, SERVER_FILENAME } from './server'

/**
 * The editor's front door: an Edit button, and the panel that explains how to
 * get a local server running when there is not one.
 *
 * This is DOM over the canvas rather than part of the low-res frame. The game
 * renders at 960x540 and letterboxes; setup instructions with copyable
 * commands and a download link have no business inside that.
 *
 * Everything here ships in the production build, because the whole point is
 * that a designer can open the published site and be walked through setup.
 */

type Platform = 'mac' | 'windows' | 'linux'

function detectPlatform(): Platform {
  const ua = navigator.userAgent
  if (/Win/i.test(ua)) return 'windows'
  if (/Mac/i.test(ua)) return 'mac'
  return 'linux'
}

/** Per-platform setup, since the designer may be on any of these. */
const SETUP: Record<Platform, {
  label: string; install: string; installNote: string; run: string; terminal: string
  /** Shown under the install command when the platform needs a follow-up. */
  installAfter?: string
}> = {
  mac: {
    label: 'macOS',
    install: 'brew install node',
    installNote: 'or download the macOS installer from nodejs.org',
    terminal: 'Open Terminal (⌘-Space, type “terminal”), then:',
    run: `node ~/Downloads/${SERVER_FILENAME}`,
  },
  windows: {
    label: 'Windows',
    install: 'winget install OpenJS.NodeJS.LTS',
    installNote: 'or download the Windows installer from nodejs.org',
    // A freshly installed Node is not on PATH in an already-open window, which
    // otherwise turns into "node is not recognized" on the very next step.
    installAfter: 'Then close PowerShell and open it again, or Windows will not ' +
      'have noticed Node yet.',
    terminal: 'Open PowerShell (Start menu, type “powershell”), then:',
    // Quoted: plenty of Windows accounts are "C:\\Users\\First Last", and
    // unquoted the space splits this into two arguments.
    run: `node "$env:USERPROFILE\\Downloads\\${SERVER_FILENAME}"`,
  },
  linux: {
    label: 'Linux',
    install: 'sudo apt install nodejs',
    installNote: 'or use your distribution’s package manager',
    terminal: 'Open a terminal, then:',
    run: `node ~/Downloads/${SERVER_FILENAME}`,
  },
}

const CSS = `
.ed-root { position: fixed; inset: 0; pointer-events: none; z-index: 50;
  font: 13px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.ed-root * { box-sizing: border-box; }
.ed-btn { pointer-events: auto; position: absolute; top: 12px; right: 12px;
  padding: 7px 15px; border-radius: 7px; border: 1px solid #3a4658;
  background: #1a2130; color: #d6e2f0; font: inherit; font-weight: 600;
  cursor: pointer; letter-spacing: .02em; }
.ed-btn:hover { background: #243043; border-color: #4d5c72; }
.ed-btn[data-state="ready"] { border-color: #3f7d55; color: #9fe0b6; }
.ed-scrim { pointer-events: auto; position: absolute; inset: 0;
  background: rgba(6, 9, 14, .72); display: grid; place-items: center; padding: 24px; }
.ed-panel { width: min(620px, 100%); max-height: 100%; overflow: auto;
  background: #141a25; color: #cdd8e6; border: 1px solid #2c3646;
  border-radius: 11px; padding: 22px 24px; box-shadow: 0 18px 60px rgba(0,0,0,.55); }
.ed-panel h2 { margin: 0 0 4px; font-size: 17px; color: #fff; }
.ed-lede { margin: 0 0 18px; color: #93a3b8; }
.ed-tabs { display: flex; gap: 6px; margin-bottom: 16px; }
.ed-tab { padding: 4px 12px; border-radius: 999px; border: 1px solid #2c3646;
  background: transparent; color: #93a3b8; font: inherit; cursor: pointer; }
.ed-tab[aria-selected="true"] { background: #232e40; color: #e8f0fa; border-color: #445269; }
.ed-step { display: grid; grid-template-columns: 22px 1fr; gap: 10px; margin-bottom: 15px; }
.ed-num { width: 22px; height: 22px; border-radius: 50%; background: #232e40;
  color: #8fa3bd; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
.ed-step h3 { margin: 2px 0 5px; font-size: 13px; color: #e8f0fa; font-weight: 600; }
.ed-step p { margin: 0 0 6px; color: #8494a8; font-size: 12px; }
.ed-cmd { position: relative; display: flex; align-items: flex-start; gap: 8px;
  background: #0c1119; border: 1px solid #232c3a; border-radius: 6px; padding: 8px 10px; }
.ed-cmd code { flex: 1; white-space: pre-wrap; word-break: break-all;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #b7e3c6; }
.ed-copy { flex: none; background: #1c2534; border: 1px solid #2f3a4b; color: #91a2b8;
  border-radius: 4px; padding: 2px 8px; font: inherit; font-size: 11px; cursor: pointer; }
.ed-copy:hover { color: #dbe6f2; }
.ed-dl { display: inline-block; padding: 6px 13px; border-radius: 6px;
  background: #2a4d7a; color: #fff; text-decoration: none; font-weight: 600; font-size: 12px; }
.ed-dl:hover { background: #345c8e; }
.ed-row { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
.ed-input { flex: 1; background: #0c1119; border: 1px solid #2b3545; border-radius: 6px;
  padding: 7px 10px; color: #e8f0fa; font: 12px ui-monospace, Menlo, Consolas, monospace; }
.ed-input:focus { outline: none; border-color: #4a7bb5; }
.ed-go { background: #2a4d7a; border: 1px solid #35608f; color: #fff; border-radius: 6px;
  padding: 7px 15px; font: inherit; font-weight: 600; cursor: pointer; }
.ed-go:hover { background: #345c8e; }
.ed-foot { display: flex; justify-content: space-between; align-items: center;
  margin-top: 18px; padding-top: 14px; border-top: 1px solid #232c3a; }
.ed-status { font-size: 12px; color: #8494a8; }
.ed-status[data-on="1"] { color: #8fdca8; }
.ed-status[data-on="err"] { color: #e79a9a; }
.ed-close { background: none; border: none; color: #7d8da0; cursor: pointer; font: inherit; }
.ed-close:hover { color: #cdd8e6; }
.ed-a { color: #6fa8e6; }
.ed-chip { position: absolute; top: 14px; right: 118px; padding: 5px 11px;
  border-radius: 999px; background: #1d3524; border: 1px solid #35603f;
  color: #9fe0b6; font-size: 11px; font-weight: 600; letter-spacing: .02em; }
`

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const kid of kids) node.append(kid)
  return node
}

/** A command block with a copy button. */
function commandBlock(text: string): HTMLElement {
  const copy = el('button', { class: 'ed-copy', type: 'button' }, 'copy')
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text)
      copy.textContent = 'copied'
    } catch {
      // Clipboard needs a secure context; the text is selectable regardless.
      copy.textContent = 'select it'
    }
    setTimeout(() => { copy.textContent = 'copy' }, 1400)
  }
  return el('div', { class: 'ed-cmd' }, el('code', {}, text), copy)
}

function step(n: number, title: string, ...body: (Node | string)[]): HTMLElement {
  return el('div', { class: 'ed-step' },
    el('div', { class: 'ed-num' }, String(n)),
    el('div', {}, el('h3', {}, title), ...body))
}

const CHIP_TEXT = 'Edit mode · game paused'

export interface EditorUiHandlers {
  /** The helper is reachable and editing has begun. */
  onEnter(server: EditorServer): void | Promise<void>
  /** The designer has left the editor and wants the game back. */
  onExit(server: EditorServer): void | Promise<void>
}

export function mountEditorUi(handlers: EditorUiHandlers): { server: EditorServer } {
  const server = new EditorServer()

  document.head.append(el('style', {}, CSS))
  const root = el('div', { class: 'ed-root' })
  document.body.append(root)

  const button = el('button', { class: 'ed-btn', type: 'button' }, 'Edit')
  root.append(button)

  let platform = detectPlatform()
  let poll: number | undefined
  let editing = false

  const chip = el('div', { class: 'ed-chip' }, CHIP_TEXT)
  chip.hidden = true
  root.append(chip)

  const closePanel = () => {
    root.querySelector('.ed-scrim')?.remove()
    if (poll !== undefined) { clearInterval(poll); poll = undefined }
  }

  function enterEditing(): void {
    if (editing) return   // the poll and a manual retry can both land
    editing = true
    closePanel()
    button.dataset.state = 'ready'
    button.textContent = 'Exit editor'
    chip.hidden = false
    // Entering does real work — indexing the content folder and rebuilding the
    // scene from it — so the button flips first and the work runs behind it.
    void Promise.resolve(handlers.onEnter(server)).catch((err) => {
      console.error('[editor] could not start editing', err)
      chip.textContent = 'Edit mode · could not load your content'
    })
  }

  function exitEditing(): void {
    editing = false
    closePanel()
    delete button.dataset.state
    button.textContent = 'Edit'
    chip.hidden = true
    chip.textContent = CHIP_TEXT
    void Promise.resolve(handlers.onExit(server)).catch((err) => {
      console.error('[editor] could not restore the game', err)
    })
  }

  async function connect(): Promise<void> {
    if ((await server.probe()).state === 'ready') { enterEditing(); return }
    openPanel()
  }

  function openPanel(): void {
    closePanel()
    const setup = SETUP[platform]

    const status = el('span', { class: 'ed-status' },
      'Waiting for the helper on ' + server.origin + '…')

    const retry = el('button', { class: 'ed-go', type: 'button' }, 'Check again')
    retry.onclick = async () => {
      status.textContent = 'Checking…'
      const next = await server.probe()
      if (next.state === 'ready') { enterEditing(); return }
      status.dataset.on = 'err'
      status.textContent = 'Still nothing on ' + server.origin
    }

    const tabs = el('div', { class: 'ed-tabs' })
    for (const p of ['mac', 'windows', 'linux'] as Platform[]) {
      const tab = el('button', {
        class: 'ed-tab', type: 'button', 'aria-selected': String(p === platform),
      }, SETUP[p].label)
      tab.onclick = () => { platform = p; openPanel() }
      tabs.append(tab)
    }

    const body = el('div', { class: 'ed-panel' },
      el('h2', {}, 'Editing needs a local server'),
      el('p', { class: 'ed-lede' },
        'The editor saves your tiles, dialogue and triggers as files on your own ' +
        'computer. A web page cannot write files by itself, so a small helper does ' +
        'it — one downloaded file that runs on your machine and writes nothing ' +
        'outside its own folder.'),
      tabs,
      step(1, 'Install Node.js',
        el('p', {}, setup.installNote + ' — you only ever do this once.'),
        commandBlock(setup.install),
        ...(setup.installAfter ? [el('p', {}, setup.installAfter)] : [])),
      step(2, 'Download the editor helper',
        el('p', {}, 'One file. Nothing to install, nothing to check out.'),
        el('a', { class: 'ed-dl', href: serverDownloadUrl(), download: SERVER_FILENAME },
          `Download ${SERVER_FILENAME}`)),
      step(3, 'Run it',
        el('p', {}, setup.terminal),
        commandBlock(setup.run),
        el('p', {}, 'It makes an “airhockey-content” folder for your work. Leave ' +
          'the window open while you edit — editing starts on its own as soon ' +
          'as it is running.'),
        el('p', {}, 'The first time, it offers to put a shortcut on your desktop ' +
          'that opens the game and starts the helper together, so you can skip ' +
          'these steps from then on.'),
        el('div', { class: 'ed-row' }, retry)),
      el('div', { class: 'ed-foot' }, status, (() => {
        const close = el('button', { class: 'ed-close', type: 'button' }, 'Close')
        close.onclick = closePanel
        return close
      })()),
    )

    const scrim = el('div', { class: 'ed-scrim' }, body)
    scrim.onclick = (e) => { if (e.target === scrim) closePanel() }
    root.append(scrim)

    // The designer starts the server in another window; notice when it appears
    // rather than making them come back and press a button.
    poll = window.setInterval(async () => {
      if ((await server.probe(900)).state === 'ready') enterEditing()
    }, 1500)
  }

  button.onclick = () => {
    button.blur()   // or the game keeps receiving keys aimed at the panel
    if (editing) exitEditing()
    else void connect()
  }

  return { server }
}
