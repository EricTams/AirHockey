import { Renderer } from './core/renderer'
import { Input } from './core/input'
import { ModeManager } from './core/mode'
import { Loop } from './core/loop'
import { DebugOverlay } from './core/debugOverlay'
import { StubMode } from './modes/stub'
import { GalleryMode } from './modes/gallery'
import { VIRTUAL_W, VIRTUAL_H, CAMERA_PITCH_DEG } from './core/config'

const gfx = new Renderer()
const input = new Input()
const modes = new ModeManager()
const debug = new DebugOverlay()

// M0: three stubs standing in for the real modes, to exercise the state machine.
modes.register(new StubMode('overworld', gfx, 0x3a7d44))
modes.register(new StubMode('dialogue', gfx, 0x2f4b7c))
modes.register(new StubMode('battle', gfx, 0x8c2f39))
modes.register(new GalleryMode(gfx))
modes.switchTo('gallery')

const loop = new Loop(
  (dt) => {
    if (input.pressed('debugOverlay')) debug.toggle()
    if (input.pressed('debugMode')) {
      const order = modes.names
      const next = order[(order.indexOf(modes.activeName) + 1) % order.length]!
      modes.switchTo(next)
    }
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
      virtual: `${VIRTUAL_W}x${VIRTUAL_H}`,
      scale: `${gfx.integerScale}x`,
      canvas: `${gfx.gl.domElement.width}x${gfx.gl.domElement.height}`,
      pitch: `${CAMERA_PITCH_DEG}deg`,
      geometries: gfx.gl.info.memory.geometries,
      textures: gfx.gl.info.memory.textures,
      keys: 'M=mode  F1=overlay',
    })
  },
)
loop.start()

console.log('[airhockey] booted', { virtual: `${VIRTUAL_W}x${VIRTUAL_H}`, modes: modes.names })

// Dev hook: lets the browser console (and automated checks) inspect live state.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__game = { gfx, input, modes, loop, debug }
}
