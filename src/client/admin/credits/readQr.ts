import { promptpayTargetOf } from "../../../shared/promptpay.ts";

/**
 * Reads the PromptPay ID out of a QR image in the browser (nothing is sent anywhere). jsQR is loaded only when
 * needed, so the rest of the admin does not carry it. null = no QR found, or not a PromptPay QR.
 */
export async function readPromptpayFromImage(image: Blob): Promise<string | null> {
  const [{ default: jsQR }, bitmap] = await Promise.all([import("jsqr"), createImageBitmap(image)]);
  try {
    // Phone screenshots are large; ~1200 px on the long side reads reliably and fast.
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" });
    return code ? promptpayTargetOf(code.data) : null;
  } finally {
    bitmap.close();
  }
}
