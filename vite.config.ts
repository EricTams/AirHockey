import { defineConfig, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'

const SERVER_FILE = 'tools/editor-server.mjs'

/**
 * Serve the editor server as a downloadable asset.
 *
 * The editor ships in the production build, so someone can press Edit on the
 * published site without ever having cloned anything. The panel they land on
 * offers this file for download, which means the built site has to carry it.
 * Emitting it from its one source here avoids a second copy going stale.
 */
function editorServerAsset(): Plugin {
  return {
    name: 'editor-server-asset',
    configureServer(server) {
      server.middlewares.use('/airhockey-editor.mjs', (_req, res) => {
        res.setHeader('content-type', 'text/javascript; charset=utf-8')
        res.end(readFileSync(SERVER_FILE))
      })
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'airhockey-editor.mjs',
        source: readFileSync(SERVER_FILE, 'utf8'),
      })
    },
  }
}

export default defineConfig({
  base: './',            // GitHub Pages compatible (doc §2: static hosting, no server)
  server: { port: 5173 },
  build: { outDir: 'dist', assetsInlineLimit: 0 },
  plugins: [editorServerAsset()],
})
