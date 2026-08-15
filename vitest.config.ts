import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure Yjs — no browser APIs needed.
    environment: 'node',
    // The relay's test spawns a real server and talks to it over a socket, so
    // it runs as a plain Node script (`npm test` in deploy/sync-server) rather
    // than as a suite here. Without this vitest collects it and reports the
    // absence of describe() as a failure.
    exclude: ['**/node_modules/**', 'deploy/**'],
  },
});
