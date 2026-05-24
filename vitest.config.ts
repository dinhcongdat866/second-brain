import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure Yjs — no browser APIs needed.
    environment: 'node',
  },
});
