import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // yjs throws "Yjs was already imported" if two module instances load.
  // dedupe forces every `import 'yjs'` to resolve to one file.
  resolve: {
    dedupe: ['yjs'],
  },
})
