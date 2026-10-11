import { afterEach, expect, test } from "vitest";
import { loadAdaptersFromEnv, parseAdapterList } from "../src/env.js";

const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
});

test("parseAdapterList rejects unknown names", () => {
  expect(parseAdapterList("telegram,slack")).toEqual(["telegram", "slack"]);
  expect(() => parseAdapterList("nope")).toThrow(/unknown adapter/);
});

test("tokens alone do not start an adapter", () => {
  setEnv("TELEGRAM_BOT_TOKEN", "123:abc");
  expect(loadAdaptersFromEnv({ enabled: [] })).toEqual([]);
});

test("enabled adapter without its token fails loudly", () => {
  setEnv("TELEGRAM_BOT_TOKEN", undefined);
  expect(() => loadAdaptersFromEnv({ enabled: ["telegram"] })).toThrow(/TELEGRAM_BOT_TOKEN/);
});
