import { describe, expect, it } from "vitest";
import { createFeishuHttp, type FeishuFetch } from "../src/http.js";

describe("createFeishuHttp apiBase", () => {
  it("uses open.feishu.cn when apiBase is omitted or empty", async () => {
    const urls: string[] = [];
    const fetchFn: FeishuFetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "t", expire: 7200, data: {} }), {
        status: 200,
      });
    };

    const omitted = createFeishuHttp({ appId: "cli_test", appSecret: "secret", fetch: fetchFn });
    await omitted.request({ method: "GET", path: "/open-apis/bot/v3/info" });
    expect(urls[0]).toMatch(/^https:\/\/open\.feishu\.cn\//);
    expect(urls.some((u) => u.startsWith("https://open.feishu.cn/open-apis/bot/v3/info"))).toBe(true);

    urls.length = 0;
    const empty = createFeishuHttp({ appId: "cli_test", appSecret: "secret", apiBase: "", fetch: fetchFn });
    await empty.request({ method: "GET", path: "/open-apis/bot/v3/info" });
    expect(urls[0]).toMatch(/^https:\/\/open\.feishu\.cn\//);
    expect(urls.some((u) => u.startsWith("https://open.feishu.cn/open-apis/bot/v3/info"))).toBe(true);
  });
});
