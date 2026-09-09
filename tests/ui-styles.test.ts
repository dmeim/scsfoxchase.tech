import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(path), "utf8");

describe("shared UI style contracts", () => {
  it("uses an embedded search field when the parent owns the search surface", () => {
    expect(source("src/components/SmartSearch.astro")).toMatch(/<SearchField\s+variant="embedded"/);
    expect(source("src/components/ui/SearchField.astro")).toContain("ui-search-field--embedded");
    expect(source("src/components/ui/styles.css")).toContain(".ui-search-field:not(.ui-search-field--embedded):focus-within");
  });

  it("gives primary header links their own glass styling contract", () => {
    const header = source("src/components/Header.astro");
    for (const href of ["/", "/games", "/help"]) {
      expect(header).toContain(`<Button href="${href}" variant="glass" size="small" class="header-nav-link"`);
    }
    expect(source("src/styles/global.css")).toContain(".header-nav-link.ui-button");
  });

  it("preserves standard backdrop filters through the production CSS minifier", async () => {
    const input = [
      ...readdirSync("src/styles").filter((file) => file.endsWith(".css")).map((file) => resolve("src/styles", file)),
      resolve("src/components/ui/styles.css"),
    ];
    const result = await build({
      configFile: false,
      logLevel: "silent",
      build: { write: false, rolldownOptions: { input } },
    });
    const bundles = Array.isArray(result) ? result : [result];
    const cssAssets = bundles.flatMap((bundle) => "output" in bundle ? bundle.output : [])
      .filter((output) => output.type === "asset" && output.fileName.endsWith(".css"));
    expect(cssAssets.length).toBeGreaterThan(0);

    let checked = 0;
    for (const asset of cssAssets) {
      if (asset.type !== "asset") continue;
      const css = String(asset.source);
      for (const block of css.matchAll(/[^{}]+\{([^{}]*)\}/g)) {
        const prefixed = block[1].match(/(?:^|;)-webkit-backdrop-filter:([^;]+)/);
        if (!prefixed) continue;
        checked++;
        const standard = block[1].match(/(?:^|;)backdrop-filter:([^;]+)/);
        expect(standard?.[1], `${asset.fileName}: ${block[0]}`).toBe(prefixed[1]);
      }
    }
    expect(checked).toBeGreaterThan(0);
  }, 30_000);
});
