import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
  resolve: {
    alias: [
      {
        find: /^imwire\/testing$/,
        replacement: `${root}packages/core/src/testing/index.ts`,
      },
      { find: /^imwire$/, replacement: `${root}packages/core/src/index.ts` },
      {
        find: /^@imwire\/telegram$/,
        replacement: `${root}packages/telegram/src/index.ts`,
      },
      {
        find: /^@imwire\/feishu$/,
        replacement: `${root}packages/feishu/src/index.ts`,
      },
    ],
  },
});
