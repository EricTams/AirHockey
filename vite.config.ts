import { defineConfig } from 'vite'

export default defineConfig({
  base: './',            // GitHub Pages compatible (doc §2: static hosting, no server)
  server: { port: 5173 },
  build: { outDir: 'dist', assetsInlineLimit: 0 },
})
