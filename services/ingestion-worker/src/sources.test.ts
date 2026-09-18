import { afterEach, describe, expect, it } from "vitest";
import { collectReports, parseFeed } from "./sources.js";

const RSS = `<rss><channel>
<item><title>Fire in Sadar</title><description><![CDATA[Fire reported <b>near Sadar</b> market]]></description><link>https://example.com/fire</link><pubDate>Mon, 15 Sep 2026 10:00:00 GMT</pubDate></item>
<item><title></title><description></description></item>
</channel></rss>`;

const ATOM = `<feed><entry><title>Medical camp</title><summary>Free checkup drive</summary></entry></feed>`;

describe("parseFeed", () => {
  it("parses RSS items and strips markup", () => {
    const [first] = parseFeed(RSS);
    expect(first.title).toBe("Fire in Sadar");
    expect(first.body).toBe("Fire reported near Sadar market");
    expect(first.url).toBe("https://example.com/fire");
    expect(first.publishedAt).toContain("2026");
  });

  it("skips empty items instead of emitting blanks", () => {
    expect(parseFeed(RSS)).toHaveLength(1);
  });

  it("parses Atom entries", () => {
    const [first] = parseFeed(ATOM, "official");
    expect(first.title).toBe("Medical camp");
    expect(first.source).toBe("official");
  });

  it("returns [] for malformed or empty feeds, never throws", () => {
    expect(parseFeed("<rss><channel><item><title>oops")).toEqual([]);
    expect(parseFeed("")).toEqual([]);
    expect(parseFeed("not xml at all")).toEqual([]);
  });
});

describe("collectReports", () => {
  afterEach(() => {
    delete process.env.RSS_FIXTURE;
  });

  it("prefers the RSS_FIXTURE override over the network", async () => {
    process.env.RSS_FIXTURE = RSS;
    process.env.RSS_FEEDS = "https://unreachable.invalid/feed";
    const reports = await collectReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].source).toBe("fixture");
  });

  it("returns [] with no feeds configured and no network needed", async () => {
    process.env.RSS_FEEDS = "";
    await expect(collectReports()).resolves.toEqual([]);
  });
});
