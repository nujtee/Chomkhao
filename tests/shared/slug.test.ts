import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CMS_TEXT, normalizeSlug, typingSlug } from "../../src/shared/cms-schema.ts";

describe("slug tidy (CMS form and server)", () => {
  it("while typing: lower case, spaces and _ become -, a word can still end with -", () => {
    assert.equal(typingSlug("House 0"), "house-0");
    assert.equal(typingSlug("house-"), "house-", "typing house-01 must stay possible");
    assert.equal(typingSlug(" House"), "house");
    assert.equal(typingSlug("A_B"), "a-b");
  });

  it("on save / leaving the field: edges trimmed, repeats collapsed, look-alikes and invisible characters fixed", () => {
    for (const [raw, want] of [
      ["house-01", "house-01"], [" house-01 ", "house-01"], ["House-01", "house-01"], ["house 01", "house-01"],
      ["house–01", "house-01"], ["house−" + "01", "house-01"], ["house​-01", "house-01"], ["ｈｏｕｓｅ－０１", "house-01"],
      ["--house--01--", "house-01"], ["house 01", "house-01"],
    ] as const) {
      assert.equal(normalizeSlug(raw), want, JSON.stringify(raw));
      assert.ok(CMS_TEXT.slug.test(normalizeSlug(raw)));
    }
    // Not a slug character: kept, so the form explains instead of silently dropping it.
    assert.equal(normalizeSlug("บ้าน-01"), "บ้าน-01");
    assert.equal(CMS_TEXT.slug.test(normalizeSlug("บ้าน-01")), false);
  });
});
