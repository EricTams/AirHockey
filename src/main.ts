import { Renderer } from './core/renderer'
import { Input } from './core/input'
import { ModeManager } from './core/mode'
import { Loop } from './core/loop'
import { Assets } from './core/assets'
import { DebugOverlay } from './core/debugOverlay'
import { StubMode } from './modes/stub'
import { GalleryMode } from './modes/gallery'
import { OverworldMode } from './modes/overworld'
import { VIRTUAL_W, VIRTUAL_H } from './core/config'

const gfx = new Renderer()
const input = new Input()
const assets = new Assets()
const modes = new ModeManager()
const debug = new DebugOverlay()

const overworld = new OverworldMode(gfx, input, assets)
await overworld.init()

modes.register(overworld)
modes.register(new StubMode('dialogue', gfx, 0x2f4b7c))
modes.register(new StubMode('battle', gfx, 0x8c2f39))
modes.register(new GalleryMode(gfx))
modes.switchTo('overworld')

const loop = new Loop(
  (dt) => {
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
  },
  () => {
    modes.render()
    gfx.present()
    debug.set({
      mode: modes.activeName,
      fps: loop.fps.toFixed(1),
      ticks: loop.ticksLastFrame,
      scale: `${gfx.integerScale}x  ${VIRTUAL_W}x${VIRTUAL_H}`,
      ...overworld.status,
      stubbed: assets.placeholders.length,
      geometries: gfx.gl.info.memory.geometries,
      textures: gfx.gl.info.memory.textures,
      keys: 'WASD move  M mode  [ ] pitch  F1',
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
  ;(window as unknown as Record<string, unknown>).__game = { gfx, input, modes, loop, debug, assets, overworld }
}
