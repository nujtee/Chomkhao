import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { en, th, zhCN, type Messages } from "../../src/shared/i18n/messages.ts";
import {
  DEFAULT_LOCALE,
  LOCALES,
  getMessages,
  localeFromPath,
  parseLocale,
} from "../../src/shared/i18n/index.ts";

function flattenKeys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? flattenKeys(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

function flattenValues(obj: object): unknown[] {
  return Object.values(obj).flatMap((v) => (typeof v === "object" && v !== null ? flattenValues(v) : [v]));
}

describe("i18n locales", () => {
  it("supports exactly th, en, zh-CN with th as default", () => {
    assert.deepEqual(
      LOCALES.map((l) => l.code),
      ["th", "en", "zh-CN"],
    );
    assert.equal(DEFAULT_LOCALE.code, "th");
  });

  it("uses lowercase URL segments /th/ /en/ /zh-cn/", () => {
    assert.deepEqual(
      LOCALES.map((l) => l.path),
      ["th", "en", "zh-cn"],
    );
  });

  it("resolves locales from path segments case-insensitively", () => {
    assert.equal(localeFromPath("zh-cn")?.code, "zh-CN");
    assert.equal(localeFromPath("ZH-CN")?.code, "zh-CN");
    assert.equal(localeFromPath("fr"), undefined);
    assert.equal(localeFromPath(""), undefined);
  });

  it("parses both BCP-47 codes and path segments", () => {
    assert.equal(parseLocale("zh-CN")?.path, "zh-cn");
    assert.equal(parseLocale(" en ")?.code, "en");
    assert.equal(parseLocale("jp"), undefined);
    assert.equal(parseLocale(null), undefined);
  });
});

describe("i18n dictionaries", () => {
  const dictionaries: Record<string, Messages> = { th, en, "zh-CN": zhCN };

  it("every locale has exactly the same keys", () => {
    const reference = flattenKeys(th).sort();
    for (const [code, dict] of Object.entries(dictionaries)) {
      assert.deepEqual(flattenKeys(dict).sort(), reference, `key mismatch in ${code}`);
    }
  });

  it("no translation is empty", () => {
    for (const [code, dict] of Object.entries(dictionaries)) {
      for (const value of flattenValues(dict)) {
        assert.equal(typeof value, "string");
        assert.ok((value as string).trim().length > 0, `empty string in ${code}`);
      }
    }
  });

  it("main menu labels follow the spec", () => {
    assert.deepEqual(Object.values(getMessages("th").nav), ["หน้าหลัก", "คลังภาพ", "จองที่พัก", "เกี่ยวกับเรา"]);
    assert.equal(getMessages("en").nav.booking, "Booking");
    assert.equal(getMessages("zh-CN").nav.booking, "立即预订");
  });
});
