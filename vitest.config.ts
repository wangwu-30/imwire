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
        find: /^@imwire\/core\/testing$/,
        replacement: `${root}packages/core/src/testing/index.ts`,
      },
      {
        find: /^imwire\/testing$/,
        replacement: `${root}packages/core/src/testing/index.ts`,
      },
      { find: /^@imwire\/core$/, replacement: `${root}packages/core/src/index.ts` },
      { find: /^imwire$/, replacement: `${root}packages/imwire/src/index.ts` },
      {
        find: /^@imwire\/telegram$/,
        replacement: `${root}packages/telegram/src/index.ts`,
      },
      {
        find: /^@imwire\/feishu$/,
        replacement: `${root}packages/feishu/src/index.ts`,
      },
      {
        find: /^@imwire\/dingtalk$/,
        replacement: `${root}packages/dingtalk/src/index.ts`,
      },
      {
        find: /^@imwire\/wecom$/,
        replacement: `${root}packages/wecom/src/index.ts`,
      },
      {
        find: /^@imwire\/slack$/,
        replacement: `${root}packages/slack/src/index.ts`,
      },
      {
        find: /^@imwire\/session$/,
        replacement: `${root}packages/session/src/index.ts`,
      },
      {
        find: /^@imwire\/agent-pi$/,
        replacement: `${root}packages/agent-pi/src/index.ts`,
      },
    ],
  },
});
