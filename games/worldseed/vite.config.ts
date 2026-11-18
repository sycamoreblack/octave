import { defineConfig } from 'vitest/config'
import { genesisPlugin } from './server/genesis'

export default defineConfig({
  // Relative base so the static build works from any folder or GitHub Pages path.
  base: './',
  plugins: [genesisPlugin()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500
  },
  test: {
    include: ['src/**/*.test.ts']
  }
})
