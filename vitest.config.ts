import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    passWithNoTests: true,
    environment: "node",
    // Fixture-driven suites read files from disk; keep output deterministic.
    sequence: { shuffle: false },
    reporters: ["default"],
  },
});
