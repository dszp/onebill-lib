import { defineConfig } from 'vitest/config';

// Node-free source stays Node-free; vitest is a dev-only dependency and never ships.
// Type-level assertions (e.g. "the read client has no write methods") are checked by
// `pnpm typecheck` (tsc -p tsconfig.test.json), not by the runtime test run here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Live smoke tests are `*.live.test.ts`; they self-skip without ONEBILL_* credentials.
    environment: 'node',
  },
});
