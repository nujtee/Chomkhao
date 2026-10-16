import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskEmailHalf, maskPhoneHalf } from "../../src/shared/booking-types.ts";
import { adminNextSegments } from "../../src/shared/routes.ts";

describe("half-hidden contact for staff notices", () => {
  it("phone: half of the digits hidden in the middle; spaces and dashes dropped", () => {
    assert.equal(maskPhoneHalf("0812345678"), "081*****78");
    assert.equal(maskPhoneHalf("081-234-5678"), "081*****78");
    assert.equal(maskPhoneHalf("+66812345678"), "+668******78");
    assert.equal(maskPhoneHalf("021234567"), "02*****67");
    assert.equal(maskPhoneHalf("123456"), "12***6");
    assert.equal(maskPhoneHalf(""), "");
    for (const phone of ["0812345678", "+66812345678", "021234567"]) {
      const digits = phone.replace(/\D/g, "");
      assert.equal(maskPhoneHalf(phone).replace(/[^*]/g, "").length, Math.ceil(digits.length / 2), phone);
    }
  });

  it("e-mail: the second half of the name before @ hidden, the domain kept", () => {
    assert.equal(maskEmailHalf("somchai@gmail.com"), "som****@gmail.com");
    assert.equal(maskEmailHalf("guest@example.test"), "gu***@example.test");
    assert.equal(maskEmailHalf("ab@x.co"), "a*@x.co");
    assert.equal(maskEmailHalf("a@x.co"), "*@x.co");
    assert.equal(maskEmailHalf(" Somchai.J@Mail.co.th "), "Somc*****@Mail.co.th");
    assert.equal(maskEmailHalf("สมชาย@ตัวอย่าง.ไทย"), "สม***@ตัวอย่าง.ไทย", "counted by character, not byte");
  });
});

describe("adminNextSegments (return to the opened admin page after signing in)", () => {
  it("accepts admin page paths only", () => {
    assert.deepEqual(adminNextSegments("bookings/BK-20261009-KN6C"), ["bookings", "BK-20261009-KN6C"]);
    assert.deepEqual(adminNextSegments("slips"), ["slips"]);
    for (const bad of [null, "", "https://evil.test", "//evil.test", "/bookings", "bookings/", "bookings/../x", "login", "reset-password/x", "a/b/c/d/e", "x?y=1", "%2F%2Fevil"]) {
      assert.equal(adminNextSegments(bad), null, String(bad));
    }
  });
});

describe("contact phone field with several numbers", async () => {
  const { normalizePhones, splitPhones, telHref } = await import("../../src/shared/phones.ts");
  it("splits on , ; / and new lines; checks each number", () => {
    assert.deepEqual(splitPhones("0637951218, 0955790679"), ["0637951218", "0955790679"]);
    assert.deepEqual(splitPhones("063-795-1218 / +66 95 579 0679;\n"), ["063-795-1218", "+66 95 579 0679"]);
    assert.deepEqual(splitPhones(null), []);
    assert.equal(normalizePhones("0637951218,0955790679"), "0637951218, 0955790679");
    assert.equal(normalizePhones("0637951218, hello"), null);
    assert.equal(normalizePhones("12-34"), null, "too short");
    assert.equal(normalizePhones(""), "");
    assert.equal(telHref("+66 95-579-0679"), "tel:+66955790679");
  });
});
