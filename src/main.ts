import { Renderer } from './core/renderer'
import { Input } from './core/input'
import { ModeManager, nextDebugMode } from './core/mode'
import { Loop } from './core/loop'
import { FailureBanner } from './core/failureBanner'
import { Assets } from './core/assets'
import { DebugOverlay } from './core/debugOverlay'
import { ShadowToggle } from './core/shadowToggle'
import { GameState } from './world/gameState'
import { GalleryMode } from './modes/gallery'
import { OverworldMode } from './modes/overworld'
import { DialogueMode } from './modes/dialogue'
import { BattleMode } from './modes/battle/battle'
import { mountEditorUi } from './editor/ui'
import { Editor } from './editor/editor'
import { VIRTUAL_W, VIRTUAL_H, TICK_DT } from './core/config'
import { fetchJson } from './core/paths'
import type { BattleConfig } from './modes/battle/physics'

const gfx = new Renderer()
const input = new Input()
const assets = new Assets()
const modes = new ModeManager()
const debug = new DebugOverlay()

const state = new GameState()
const overworld = new OverworldMode(gfx, input, assets, state)
await overworld.init()

// The world picks the default; the button is here to compare the styles
// against real art rather than against a screenshot.
const shadowToggle = new ShadowToggle((style) => overworld.setShadowStyle(style), overworld.shadows)

// Dialogue draws over a frozen overworld (doc §7.2), so it renders it directly.
const dialogue = new DialogueMode(gfx, input, assets, overworld)
const battle = new BattleMode(gfx, input, assets)

const switchTo = (mode: string, payload?: unknown) => modes.switchTo(mode, payload)
overworld.bindSwitch(switchTo)
dialogue.bindSwitch(switchTo)
battle.bindSwitch(switchTo)

modes.register(overworld)
modes.register(dialogue)
modes.register(battle)
modes.register(new GalleryMode(gfx))
modes.switchTo('overworld')

/**
 * One logic tick. Named so the dev hook can drive it directly: browsers freeze
 * requestAnimationFrame in a background tab, which makes the game unobservable
 * from automation. Stepping it by hand runs the sim regardless.
 */
const tick = (dt: number) => {
  if (input.pressed('debugOverlay')) debug.toggle()
  if (input.pressed('debugMode')) modes.switchTo(nextDebugMode(modes.activeName))
  // Scrub the camera pitch live to evaluate the 2.5D look against real art.
  if (input.pressed('pitchDown')) overworld.setPitch(overworld.pitch - 5)
  if (input.pressed('pitchUp')) overworld.setPitch(overworld.pitch + 5)
  modes.update(dt)
  input.endTick()
}

const banner = new FailureBanner()

const loop = new Loop(
  tick,
  () => {
    modes.render()
    gfx.present()
    debug.set({
      mode: modes.activeName,
      fps: loop.fps.toFixed(1),
      ticks: loop.ticksLastFrame,
      scale: `${gfx.integerScale}x  ${VIRTUAL_W}x${VIRTUAL_H}`,
      ...(modes.activeName === 'overworld' ? overworld.status : {}),
      ...(modes.activeName === 'battle' ? battle.status : {}),
      stubbed: assets.placeholders.length,
      contained: loop.failureCount,
      geometries: gfx.gl.info.memory.geometries,
      textures: gfx.gl.info.memory.textures,
      keys: 'WASD/mouse move  Z talk  M mode  [ ] pitch  F1 overlay',
    })
  },
  (failure) => banner.show(failure),
)
loop.start()

/**
 * The editor ships in the production build: pressing Edit on the published site
 * walks you through standing up a local server (src/editor/ui.ts).
 *
 * Editing suspends the game rather than overlaying a running one. The loop
 * keeps presenting frames — the editor needs a picture to draw on — but no
 * logic ticks run, so nothing walks, animates, or reads input behind the
 * editor's back.
 */
let session: Editor | undefined
/** Debug overlay state to put back when the editor closes. */
let debugWasVisible = false
/** Whether content reads have already been pointed at the helper this session. */
let routed = false

const editor = mountEditorUi({
  async onEnter(server) {
    // Editing acts on the overworld, so settle any pending mode change with a
    // single tick before the sim stops.
    if (modes.activeName !== 'overworld') {
      modes.switchTo('overworld')
      tick(TICK_DT)
    }
    loop.setPaused(true)
    input.reset()
    // The readout is a dev tool, and it sits on top of the editor's own
    // chrome. Editing is the designer's screen, not ours.
    debugWasVisible = debug.visible
    debug.setVisible(false)
    shadowToggle.setVisible(false)

    // Point content reads at the designer's own folder, then rebuild the world
    // from it. Anything they had already edited was loaded from the site during
    // boot, so those textures are stale and have to be dropped by hand.
    //
    // Only on the first entry: re-entering must not reload the map out from
    // under edits the designer made, left the editor to walk around, and came
    // back to finish.
    if (!routed) {
      await server.install()
      for (const path of server.editedPaths ?? []) assets.invalidate(path)
      await overworld.reload()
      routed = true
    }

    session ??= new Editor({ gfx, assets, overworld, modes, dialogue, state }, editor.root)
    await session.open(server)

    const edited = server.editedPaths?.size ?? 0
    console.log('[editor] editing against', server.origin,
      `- game paused, ${edited} edited file(s)`)
  },
  onExit() {
    // Content stays routed at the helper, so leaving the editor drops the
    // designer into the world they just built rather than back into the one the
    // site shipped. The scene already holds every edit, saved or not, so there
    // is nothing to reload.
    session?.close()
    debug.setVisible(debugWasVisible)
    shadowToggle.setVisible(true)
    // Resuming play is the moment whatever failed may have just been fixed, so
    // the notice starts clear. If it has not been fixed it is back within a
    // frame, which is the only honest way to dismiss it.
    banner.clear()
    input.reset()   // drop anything held while the editor had focus
    loop.setPaused(false)
    console.log('[editor] resumed, playing your content')
  },
})

console.log('[airhockey] booted', {
  virtual: `${VIRTUAL_W}x${VIRTUAL_H}`,
  modes: modes.names,
  placeholders: assets.placeholders,
})

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__game = {
    gfx, input, modes, loop, debug, assets, state, overworld, dialogue, battle, editor,
    shadowToggle,
    get session() { return session },
    /** Jump straight into any arena, skipping the walk and the dialogue. */
    async startBattle(id = 'blorb') {
      const config = await fetchJson<BattleConfig>(`data/battles/${id}.json`)
      modes.switchTo('battle', { config, returnTo: 'overworld' })
      return id
    },
    /** Advance the simulation by n logic ticks without waiting on the display. */
    tick(n = 1) {
      for (let i = 0; i < n; i++) tick(TICK_DT)
    },
  }
}
