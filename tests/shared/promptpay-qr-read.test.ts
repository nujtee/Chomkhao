import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jsQR from "jsqr";
import { encodeQr } from "../../src/shared/qr.ts";
import { promptpayPayload, promptpayTargetOf } from "../../src/shared/promptpay.ts";

/** Rasterises a QR matrix to RGBA (white quiet zone, `scale` px per module), like a screenshot of it. */
function raster(modules: boolean[][], scale = 6, quiet = 4): { data: Uint8ClampedArray; size: number } {
  const size = (modules.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }));
  return { data, size };
}

describe("top-up QR: the PromptPay ID is read from the image (jsQR, as in the browser)", () => {
  it("a K PLUS-style e-Wallet QR gives its 15-digit ID", () => {
    const { data, size } = raster(encodeQr(promptpayPayload("004999999995858", null)!));
    const code = jsQR(data, size, size);
    assert.ok(code, "QR found");
    assert.equal(promptpayTargetOf(code.data), "004999999995858");
  });
});
