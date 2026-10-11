import { describe, expect, it } from "vitest";
import { chunkText } from "../src/chunk.js";

describe("chunkText", () => {
  it("returns a single chunk when under the limit", () => {
    expect(chunkText("hello", 10)).toEqual(["hello"]);
  });

  it("returns one empty chunk for empty input", () => {
    expect(chunkText("", 10)).toEqual([""]);
  });

  it("splits on paragraph then line then space", () => {
    const text = "aaaa\n\nbbbb cccc dddd";
    expect(chunkText(text, 10)).toEqual(["aaaa", "bbbb cccc", "dddd"]);
  });

  it("hard-splits when there is no whitespace", () => {
    expect(chunkText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("does not split a surrogate pair", () => {
    const text = "ab😀cd";
    const chunks = chunkText(text, 3);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });

  it("rejects a non-positive limit", () => {
    expect(() => chunkText("x", 0)).toThrow(/maxLen/);
  });
});
