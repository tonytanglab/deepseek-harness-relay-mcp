import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/mcp.ts'],
  format: ['esm'],
  platform: 'node',
  outDir: 'lib',
  dts: false,
  clean: true,
  fixedExtension: false,
})
