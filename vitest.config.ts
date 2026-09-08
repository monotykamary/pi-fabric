import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    maxWorkers: 2,
    // Real worker processes and cold TypeScript compilers share this suite.
    // Behavioral timeouts and performance budgets remain asserted by tests.
    testTimeout: 15_000,
    restoreMocks: true,
  },
});
