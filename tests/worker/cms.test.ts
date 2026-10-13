import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CmsRecord } from "../../src/shared/cms-schema.ts";
import type { PublicGalleryDto, PublicHistoryDto, PublicHomeDto } from "../../src/shared/content-types.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

let seq = 0;
async function staff(h: Harness, perms: string[]) {
  const id = `cms_staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

async function image(h: Harness, token: string, purpose: string) {
  const res = await h.upload<{ id: string; url: string }>(token, { bytes: pngBytes(1600, 900), name: "x.png", type: "image/png" }, purpose);
  assert.equal(res.status, 201, JSON.stringify(res));
  return res.data;
}

const api = <T = CmsRecord>(h: Harness, method: string, path: string, token: string, body?: unknown) =>
  h.api<T>(method, `/api/admin/cms/${path}`, { token, body });

describe("home hero slides (spec §9)", () => {
  it("requires a HOME_SLIDE image, validates links, schedules and expires", async () => {
    const h = new Harness({ seed: true });
    const editor = await staff(h, ["content.view", "content.home", "content.publish"]);
    const slideImg = await image(h, editor, "HOME_SLIDE");

    const noImage = await api(h, "POST", "homeSlide", editor, { translations: { th: { title: "สไลด์" } } });
    assert.equal(noImage.error?.details?.desktopAssetId, "REQUIRED");

    const gallery = await staff(h, ["content.gallery"]);
    const galleryImg = await image(h, gallery, "GALLERY");
    const wrong = await api(h, "POST", "homeSlide", editor, { desktopAssetId: galleryImg.id });
    assert.equal(wrong.error?.details?.desktopAssetId, "WRONG_MEDIA_PURPOSE");

    for (const url of ["javascript:alert(1)", "//evil.example", "http://plain.example", "/ok path"]) {
      const bad = await api(h, "POST", "homeSlide", editor, { desktopAssetId: slideImg.id, button1Url: url });
      assert.equal(bad.error?.details?.button1Url, "INVALID_URL", url);
    }
    const mass = await api(h, "POST", "homeSlide", editor, { desktopAssetId: slideImg.id, status: "PUBLISHED" });
    assert.equal(mass.error?.details?.status, "UNKNOWN_FIELD", "status changes only through publish");
    const ctrl = await api(h, "POST", "homeSlide", editor, { desktopAssetId: slideImg.id, translations: { th: { title: "a\u0000b" } } });
    assert.equal(ctrl.error?.details?.["translations.th.title"], "INVALID_CHARACTERS");

    const created = await api(h, "POST", "homeSlide", editor, {
      desktopAssetId: slideImg.id, button1Url: "/th/booking", startAt: "2027-01-11T00:00:00Z", endAt: "2027-01-20T00:00:00Z",
      translations: { th: { title: "ยินดีต้อนรับ", button1Label: "จองเลย" }, en: { title: "Welcome" } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.data.status, "DRAFT");
    assert.equal(created.data.urls.desktopAssetId, slideImg.url);
    const id = created.data.id;

    const pub = await api(h, "POST", `homeSlide/${id}/publish`, editor);
    assert.equal(pub.data.status, "SCHEDULED");
    let home = (await h.api<PublicHomeDto>("GET", "/api/public/home?lang=en")).data;
    assert.equal(home.slides.length, 0, "not before its start time");

    h.advance(24 * 3600_000);
    home = (await h.api<PublicHomeDto>("GET", "/api/public/home?lang=en")).data;
    assert.equal(home.slides.length, 1);
    assert.equal(home.slides[0]!.title, "Welcome");
    assert.equal(home.slides[0]!.button1, null, "EN has no button label → no button");
    const th = (await h.api<PublicHomeDto>("GET", "/api/public/home?lang=th")).data;
    assert.deepEqual(th.slides[0]!.button1, { label: "จองเลย", url: "/th/booking" });
    const zh = (await h.api<PublicHomeDto>("GET", "/api/public/home?lang=zh-cn")).data;
    assert.equal(zh.slides[0]!.title, "ยินดีต้อนรับ", "falls back to the default language");

    h.advance(10 * 24 * 3600_000);
    const editor2 = await staff(h, ["content.view", "content.home", "content.publish"]); // sessions expire after 12 h
    const list = await api<CmsRecord[]>(h, "GET", "homeSlide", editor2);
    assert.equal(list.data[0]!.effectiveStatus, "EXPIRED");
    assert.equal((await h.api<PublicHomeDto>("GET", "/api/public/home")).data.slides.length, 0);
    const ended = await api(h, "POST", `homeSlide/${id}/publish`, editor2);
    assert.equal(ended.error?.code, "SLIDE_ENDED");

    const order = await api(h, "PUT", "homeSlide/order", editor2, { ids: [id, "nope"] });
    assert.equal(order.error?.details?.ids, "UNKNOWN_ID");
    const del = await api(h, "DELETE", `homeSlide/${id}`, editor2);
    assert.equal(del.status, 200);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM home_slide_translations WHERE slide_id = ?", id)?.n, 0);
    assert.equal(h.audits("DELETE").length, 1);
  });

  it("separates view, edit and publish permissions", async () => {
    const h = new Harness({ seed: true });
    const viewer = await staff(h, ["content.view"]);
    assert.equal((await api<CmsRecord[]>(h, "GET", "homeSection", viewer)).data.length, 2);
    assert.equal((await api(h, "POST", "homeSection", viewer, { sectionType: "CUSTOM" })).status, 403);
    const editor = await staff(h, ["content.view", "content.home"]);
    const created = await api(h, "POST", "homeSection", editor, { sectionType: "CUSTOM", translations: { th: { title: "ใหม่", body: "บรรทัด 1\nบรรทัด 2" } } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.data.translations.th?.body, "บรรทัด 1\nบรรทัด 2", "line breaks kept, plain text");
    assert.equal((await api(h, "POST", `homeSection/${created.data.id}/publish`, editor)).status, 403);
    const galleryOnly = await staff(h, ["content.view", "content.gallery"]);
    assert.equal((await api(h, "PATCH", `homeSection/${created.data.id}`, galleryOnly, { sortOrder: 5 })).status, 403);
    assert.equal((await api(h, "GET", "notAnEntity", viewer)).status, 404);
    assert.equal(h.events("PERMISSION_DENIED").length, 3);
  });
});

describe("gallery CMS (spec §10)", () => {
  it("slugs are tidied, not refused, for capitals, spaces, _ , dash look-alikes and invisible characters", async () => {
    const h = new Harness({ seed: true });
    const editor = await staff(h, ["content.view", "content.gallery"]);
    const make = (slug: string) => api(h, "POST", "galleryCategory", editor, { slug, sortOrder: 1, translations: { th: { name: "บ้านพัก" } } });
    const first = await make(" House 01 ");
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.data.slug, "house-01");
    // The same slug typed differently is the same slug: taken.
    for (const same of ["house-01 ", "HOUSE_01", "house\u201301", "house\u200b-01", "house--01", "-house-01-", "ｈｏｕｓｅ-01"]) {
      const r = await make(same);
      assert.deepEqual([r.status, r.error?.details?.slug], [409, "TAKEN"], same);
    }
    for (const bad of ["บ้าน-01", "house/01", "house.01"]) assert.equal((await make(bad)).error?.details?.slug, "SLUG_FORMAT", bad);
    assert.equal((await make("  ")).error?.details?.slug, "REQUIRED");
    const edited = await api(h, "PATCH", `galleryCategory/${first.data.id}`, editor, { slug: "Rooms And Views" });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.data.slug, "rooms-and-views");
  });

  it("shows only published images of published categories; categories need a Thai name", async () => {
    const h = new Harness({ seed: true });
    const editor = await staff(h, ["content.view", "content.gallery", "content.publish"]);
    const noName = await api(h, "POST", "galleryCategory", editor, { slug: "food", translations: { en: { name: "Food" } } });
    assert.equal(noName.error?.details?.["translations.th.name"], "REQUIRED");
    const badSlug = await api(h, "POST", "galleryCategory", editor, { slug: "อาหาร", translations: { th: { name: "อาหาร" } } });
    assert.equal(badSlug.error?.details?.slug, "SLUG_FORMAT");
    const dupe = await api(h, "POST", "galleryCategory", editor, { slug: "nature", translations: { th: { name: "ซ้ำ" } } });
    assert.equal(dupe.status, 409);
    assert.equal(dupe.error?.details?.slug, "TAKEN");

    const cat = await api(h, "POST", "galleryCategory", editor, { slug: "food", translations: { th: { name: "อาหาร" }, en: { name: "Food" } } });
    assert.equal(cat.status, 201);
    const img1 = await image(h, editor, "GALLERY");
    const img2 = await image(h, editor, "GALLERY");
    const a = await api(h, "POST", "galleryImage", editor, { mediaAssetId: img1.id, categoryId: cat.data.id, translations: { th: { altText: "จานอาหาร" } } });
    const b = await api(h, "POST", "galleryImage", editor, { mediaAssetId: img2.id, categoryId: "dev_gallery_nature", layoutSpan: "WIDE" });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const ghost = await api(h, "POST", "galleryImage", editor, { mediaAssetId: img2.id, categoryId: "missing" });
    assert.equal(ghost.error?.details?.categoryId, "NOT_FOUND");

    await api(h, "POST", `galleryImage/${a.data.id}/publish`, editor);
    await api(h, "POST", `galleryImage/${b.data.id}/publish`, editor);
    let g = (await h.api<PublicGalleryDto>("GET", "/api/public/gallery?lang=th")).data;
    assert.deepEqual(g.images.map((i) => i.id), [b.data.id], "image in a DRAFT category stays hidden");
    await api(h, "POST", `galleryCategory/${cat.data.id}/publish`, editor);
    g = (await h.api<PublicGalleryDto>("GET", "/api/public/gallery?lang=th")).data;
    assert.equal(g.images.length, 2);
    assert.equal(g.images.find((i) => i.id === a.data.id)?.image.alt, "จานอาหาร");
    assert.ok(g.categories.some((c) => c.slug === "food" && c.name === "อาหาร"));

    const reordered = await api<CmsRecord[]>(h, "PUT", "galleryImage/order", editor, { ids: [b.data.id, a.data.id] });
    assert.deepEqual(reordered.data.map((r) => r.id), [b.data.id, a.data.id]);
    const filtered = await api<CmsRecord[]>(h, "GET", `galleryImage?categoryId=${cat.data.id}`, editor);
    assert.deepEqual(filtered.data.map((r) => r.id), [a.data.id]);

    const busy = await api(h, "DELETE", `galleryCategory/${cat.data.id}`, editor);
    assert.equal(busy.error?.code, "CATEGORY_NOT_EMPTY");
    await api(h, "DELETE", `galleryImage/${a.data.id}`, editor);
    assert.equal((await api(h, "DELETE", `galleryCategory/${cat.data.id}`, editor)).status, 200);
    g = (await h.api<PublicGalleryDto>("GET", "/api/public/gallery?lang=th")).data;
    assert.deepEqual(g.images.map((i) => i.id), [b.data.id]);
    assert.equal((await api(h, "GET", `galleryImage/${a.data.id}`, editor)).status, 404, "soft-deleted records are gone from admin lists");

    const unpub = await api(h, "POST", `galleryImage/${b.data.id}/unpublish`, editor);
    assert.equal(unpub.data.status, "UNPUBLISHED");
    assert.ok(unpub.data.publishedAt, "first publish time is kept");
    assert.equal((await h.api<PublicGalleryDto>("GET", "/api/public/gallery")).data.images.length, 0);
  });
});

describe("history CMS (spec §11)", () => {
  it("timeline needs a Thai title to publish; sections render in order", async () => {
    const h = new Harness({ seed: true });
    const editor = await staff(h, ["content.view", "content.history", "content.publish"]);
    const noTitle = await api(h, "POST", "historyTimeline", editor, { year: 2025 });
    assert.equal(noTitle.error?.details?.["translations.th.title"], "REQUIRED");
    const badYear = await api(h, "POST", "historyTimeline", editor, { year: 99, translations: { th: { title: "x" } } });
    assert.equal(badYear.error?.details?.year, "OUT_OF_RANGE");
    const t = await api(h, "POST", "historyTimeline", editor, { year: 2025, translations: { th: { title: "ขยายพื้นที่" }, en: { title: "Expansion" } } });
    await api(h, "POST", `historyTimeline/${t.data.id}/publish`, editor);
    const removeTh = await api(h, "PATCH", `historyTimeline/${t.data.id}`, editor, { translations: { th: null } });
    assert.equal(removeTh.error?.details?.["translations.th.title"], "REQUIRED");

    const s = await api(h, "POST", "historySection", editor, {
      sectionType: "QUOTE", layout: "FULL_WIDTH", translations: { th: { body: "คำพูด", quoteAuthor: "ผู้ก่อตั้ง" } },
    });
    await api(h, "POST", `historySection/${s.data.id}/publish`, editor);
    const pub = (await h.api<PublicHistoryDto>("GET", "/api/public/history?lang=en")).data;
    assert.deepEqual(pub.timeline.map((x) => x.year), [2020, 2024, 2025]);
    assert.equal(pub.timeline.at(-1)?.title, "Expansion");
    assert.equal(pub.sections.at(-1)?.quoteAuthor, "ผู้ก่อตั้ง");
    assert.equal((await h.api("GET", "/api/public/history/timeline?lang=fr")).status, 400);
  });
});

describe("food codes: optional, tidied, made by the server when empty", () => {
  it("category: letters only (database CHECK), clear errors, auto code from the English name, unique", async () => {
    const h = new Harness({ seed: true });
    const chef = await staff(h, ["food.view", "food.edit"]);
    const cat = (code: unknown, en?: string) => api(h, "POST", "foodCategory", chef, {
      ...(code === undefined ? {} : { code }), deadlineType: "NONE", status: "ACTIVE",
      translations: { th: { name: "หมวดทดสอบ" }, ...(en ? { en: { name: en } } : {}) },
    });
    const digits = await cat("001");
    assert.equal(digits.status, 422);
    assert.equal(digits.error?.details?.code, "CODE_LETTERS_ONLY");
    assert.equal((await cat("ข้าว")).error?.details?.code, "CODE_LETTERS_ONLY");

    const tidied = await cat("late night");
    assert.equal(tidied.status, 201, JSON.stringify(tidied.body));
    assert.equal(tidied.data.code, "LATE_NIGHT", "upper case, spaces become _");

    const fromName = await cat(undefined, "Night snack 2");
    assert.equal(fromName.status, 201, JSON.stringify(fromName.body));
    assert.equal(fromName.data.code, "NIGHT_SNACK");
    const again = await cat(null, "Night snack");
    assert.equal(again.data.code, "NIGHT_SNACK_B", "next free one, still letters only");
    const thaiOnly = await cat("");
    assert.equal(thaiOnly.status, 201);
    assert.equal(thaiOnly.data.code, "CATEGORY");
    assert.equal((await cat("")).data.code, "CATEGORY_B");
    assert.equal((await cat("CATEGORY")).error?.details?.code, "TAKEN", "a typed code that is taken is the admin's to change");
  });

  it("dish: digits allowed after the first letter; auto code from the English name with _2, _3", async () => {
    const h = new Harness({ seed: true });
    const chef = await staff(h, ["food.view", "food.edit"]);
    const dish = (code: unknown, en?: string) => api(h, "POST", "foodOption", chef, {
      foodCategoryId: "dev_food_dinner", ...(code === undefined ? {} : { code }), pricingType: "PER_PERSON", priceSatang: 20000,
      translations: { th: { name: "ข้าวผัด" }, ...(en ? { en: { name: en } } : {}) },
    });
    assert.equal((await dish("001")).error?.details?.code, "CODE_FORMAT");
    assert.equal((await dish("set a1")).data.code, "SET_A1");
    assert.equal((await dish(undefined, "Fried rice")).data.code, "FRIED_RICE");
    assert.equal((await dish(undefined, "Fried rice")).data.code, "FRIED_RICE_2");
    assert.equal((await dish(undefined)).data.code, "DISH");
  });
});

describe("food menu CMS (spec §19–23)", () => {
  it("validates pricing rules, audits price changes, and hides inactive options from guests", async () => {
    const h = new Harness({ seed: true });
    const chef = await staff(h, ["food.view", "food.edit"]);
    const special = await api(h, "POST", "foodOption", chef, {
      foodCategoryId: "dev_food_dinner", code: "DINNER_B", pricingType: "PER_PERSON", priceSatang: 30000, childPricing: "SPECIAL_PRICE",
      translations: { th: { name: "อาหารเย็น B" } },
    });
    assert.equal(special.error?.details?.childPriceSatang, "REQUIRED");
    const set = await api(h, "POST", "foodOption", chef, {
      foodCategoryId: "dev_food_bbq", code: "BBQ_BIG", pricingType: "PER_SET", priceSatang: 59900, translations: { th: { name: "ชุดใหญ่" } },
    });
    assert.equal(set.error?.details?.personsPerSet, "REQUIRED");

    const created = await api(h, "POST", "foodOption", chef, {
      foodCategoryId: "dev_food_dinner", code: "DINNER_B", pricingType: "PER_PERSON", priceSatang: 30000, childPricing: "SPECIAL_PRICE",
      childPriceSatang: 10000, status: "ACTIVE", translations: { th: { name: "อาหารเย็น B" }, en: { name: "Dinner B" } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const immut = await api(h, "PATCH", `foodOption/${created.data.id}`, chef, { code: "OTHER" });
    assert.equal(immut.error?.details?.code, "IMMUTABLE");
    const priced = await api(h, "PATCH", `foodOption/${created.data.id}`, chef, { priceSatang: 32000, childPricing: "HALF" });
    assert.equal(priced.data.priceSatang, 32000);
    assert.equal(priced.data.childPriceSatang, null, "special child price cleared when not used");
    const audit = h.audits("UPDATE").at(-1)!;
    assert.match(audit.old_value!, /"priceSatang":30000/);
    assert.match(audit.new_value!, /"priceSatang":32000/);

    const options = async () => (await h.api<{ id: string }[] | { options: { id: string }[] }>("GET", "/api/public/food-options?lang=th&checkIn=2027-02-01&checkOut=2027-02-03")).body;
    assert.match(JSON.stringify(await options()), new RegExp(created.data.id));
    await api(h, "PATCH", `foodOption/${created.data.id}`, chef, { status: "INACTIVE" });
    assert.doesNotMatch(JSON.stringify(await options()), new RegExp(created.data.id));

    const inUse = await api(h, "DELETE", "foodOption/dev_food_breakfast_a", chef);
    assert.equal(inUse.error?.code, "OPTION_IN_USE", "included meal still points at it");
    assert.equal((await api(h, "DELETE", `foodOption/${created.data.id}`, chef)).status, 200);
    assert.equal(h.db.get("SELECT status FROM food_options WHERE id = ?", created.data.id)?.status, "DELETED", "soft delete keeps booking history");

    const mismatch = await api(h, "POST", "includedMeal", chef, {
      targetType: "UNIT", unitId: "dev_house_02", foodCategoryId: "dev_food_dinner", foodOptionId: "dev_food_breakfast_a", personsPerNight: 2,
    });
    assert.equal(mismatch.error?.details?.foodOptionId, "CATEGORY_MISMATCH");
    const meal = await api(h, "POST", "includedMeal", chef, { targetType: "UNIT_TYPE", unitType: "VIP_TENT", unitId: "dev_house_02", foodCategoryId: "dev_food_breakfast", personsPerNight: 2 });
    assert.equal(meal.status, 201, JSON.stringify(meal.body));
    assert.equal(meal.data.unitId, null, "unit id cleared for a unit-type rule");
    assert.equal((await api(h, "DELETE", `includedMeal/${meal.data.id}`, chef)).status, 405);
  });

  it("deadline fields follow the deadline type; a new default limit reaches future days", async () => {
    const h = new Harness({ seed: true });
    const chef = await staff(h, ["food.view", "food.edit"]);
    const bad = await api(h, "PATCH", "foodCategory/dev_food_dinner", chef, { deadlineType: "PREVIOUS_DAY_TIME" });
    assert.equal(bad.error?.details?.deadlineTime, "REQUIRED");
    const ok = await api(h, "PATCH", "foodCategory/dev_food_dinner", chef, { deadlineType: "PREVIOUS_DAY_TIME", deadlineTime: "17:00" });
    assert.equal(ok.data.deadlineDaysBefore, null);
    h.db.run("INSERT INTO food_daily_capacity (food_category_id, service_date, max_quantity, used_quantity) VALUES ('dev_food_dinner', '2027-02-01', 50, 4)");
    h.db.run("INSERT INTO food_daily_capacity (food_category_id, service_date, max_quantity, used_quantity) VALUES ('dev_food_dinner', '2027-02-02', 70, 0)");
    await api(h, "PATCH", "foodCategory/dev_food_dinner", chef, { defaultDailyCapacity: 60 });
    assert.equal(h.db.get("SELECT max_quantity FROM food_daily_capacity WHERE service_date = '2027-02-01'")?.max_quantity, 60);
    assert.equal(h.db.get("SELECT max_quantity FROM food_daily_capacity WHERE service_date = '2027-02-02'")?.max_quantity, 70, "per-day override kept");
    assert.equal((await api(h, "DELETE", "foodCategory/dev_food_dinner", chef)).status, 405);
  });
});

describe("SEO redirects", () => {
  it("rejects reserved, unsafe and duplicate paths", async () => {
    const h = new Harness({ seed: true });
    const seo = await staff(h, ["seo.edit"]);
    for (const [fromPath, toPath, field, code] of [
      ["/api/x", "/th/", "fromPath", "RESERVED_PATH"],
      ["/th/admin/users", "/th/", "fromPath", "RESERVED_PATH"],
      ["/old", "https://evil.example", "toPath", "INVALID_PATH"],
      ["/old", "//evil.example", "toPath", "INVALID_PATH"],
      ["/a/../b", "/th/", "fromPath", "INVALID_PATH"],
      ["/same", "/same", "toPath", "SAME_AS_SOURCE"],
    ] as const) {
      const res = await api(h, "POST", "seoRedirect", seo, { fromPath, toPath });
      assert.equal(res.error?.details?.[field], code, `${fromPath} → ${toPath}`);
    }
    assert.equal((await api(h, "POST", "seoRedirect", seo, { fromPath: "/old-page", toPath: "/th/history", statusCode: 301 })).status, 201);
    assert.equal((await api(h, "POST", "seoRedirect", seo, { fromPath: "/old-page", toPath: "/th/" })).status, 409);
    assert.equal((await api(h, "POST", "seoRedirect", seo, { fromPath: "/x", toPath: "/y", statusCode: 303 })).error?.details?.statusCode, "INVALID_VALUE");
  });
});
