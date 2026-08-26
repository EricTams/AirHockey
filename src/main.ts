import { Renderer } from './core/renderer'
import { Input } from './core/input'
import { ModeManager } from './core/mode'
import { Loop } from './core/loop'
import { Assets } from './core/assets'
import { DebugOverlay } from './core/debugOverlay'
import { GalleryMode } from './modes/gallery'
import { OverworldMode } from './modes/overworld'
import { DialogueMode } from './modes/dialogue'
import { BattleMode } from './modes/battle/battle'
import { VIRTUAL_W, VIRTUAL_H, TICK_DT } from './core/config'
import { fetchJson } from './core/paths'
import type { BattleConfig } from './modes/battle/physics'

const gfx = new Renderer()
const input = new Input()
const assets = new Assets()
const modes = new ModeManager()
const debug = new DebugOverlay()

const overworld = new OverworldMode(gfx, input, assets)
await overworld.init()

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
  if (input.pressed('debugMode')) {
    const order = modes.names
    const next = order[(order.indexOf(modes.activeName) + 1) % order.length]!
    modes.switchTo(next)
  }
  // Scrub the camera pitch live to evaluate the 2.5D look against real art.
  if (input.pressed('pitchDown')) overworld.setPitch(overworld.pitch - 5)
  if (input.pressed('pitchUp')) overworld.setPitch(overworld.pitch + 5)
  modes.update(dt)
  input.endTick()
}

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
      geometries: gfx.gl.info.memory.geometries,
      textures: gfx.gl.info.memory.textures,
      keys: 'WASD/mouse  Z  M mode  T trap  Y autoplay  F1',
    })
  },
)
loop.start()

console.log('[airhockey] booted', {
  virtual: `${VIRTUAL_W}x${VIRTUAL_H}`,
  modes: modes.names,
  placeholders: assets.placeholders,
})

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__game = {
    gfx, input, modes, loop, debug, assets, overworld, dialogue, battle,
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
