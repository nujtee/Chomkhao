import { isPreviewTile } from "../../shared/map-tiles.ts";
import type { FetchLike } from "../line/line-api.ts";

/**
 * GET /map-tiles/<z>/<x>/<y>.png — the footer map thumbnail (OpenStreetMap tiles).
 *
 * Fetched by the Worker, not by the visitor's browser: no third-party request from the site (privacy,
 * CSP unchanged) and the tiles come from Cloudflare's edge cache. Only the few tiles around the site's
 * own coordinates are served; anything else is 404, so this is not an open proxy.
 * OpenStreetMap tile policy: identifying User-Agent and Referer, cache ≥ 7 days, visible attribution
 * (shown on the thumbnail by the client).
 */
export const MAP_TILE_PATH = /^\/map-tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/;

const UPSTREAM = "https://tile.openstreetmap.org";
const MAX_BYTES = 300_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const TILE_CACHE_CONTROL = "public, max-age=604800";

/** The part of the Workers Cache API used here (`caches.default`; absent in Node tests). */
export interface TileCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}

export interface MapTileOptions {
  fetch?: FetchLike;
  cache?: TileCache | null;
  /** Site address, for the User-Agent and Referer the tile servers ask for. */
  siteUrl: string;
}

export class MapTileService {
  constructor(
    private readonly coordinates: () => Promise<{ latitude: number; longitude: number } | null>,
    private readonly options: MapTileOptions,
  ) {}

  async serve(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const m = MAP_TILE_PATH.exec(url.pathname);
    if (!m) return notFound();
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];

    // Cache key without query string: one copy per tile.
    const key = new Request(`${url.origin}/map-tiles/${z}/${x}/${y}.png`);
    const cached = await this.options.cache?.match(key).catch(() => undefined);
    if (cached) return cached;

    const c = await this.coordinates();
    if (!c || !isPreviewTile(c.latitude, c.longitude, z, x, y)) return notFound();

    const fetchImpl = this.options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const upstream = await fetchImpl(`${UPSTREAM}/${z}/${x}/${y}.png`, {
        headers: {
          "User-Agent": `Chomkhao/1.0 (+${this.options.siteUrl})`,
          Referer: `${this.options.siteUrl}/`,
          Accept: "image/png",
        },
      });
      if (!upstream.ok) return unavailable(`upstream ${upstream.status}`);
      bytes = new Uint8Array(await upstream.arrayBuffer());
    } catch (error) {
      return unavailable(String(error).slice(0, 120));
    }
    if (bytes.length > MAX_BYTES || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return unavailable("not a png tile");

    const response = new Response(bytes, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": TILE_CACHE_CONTROL,
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
    await this.options.cache?.put(key, response.clone()).catch(() => undefined);
    return response;
  }
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" } });
}

/** The thumbnail hides itself when a tile fails; the "Map" link next to it still works. */
function unavailable(reason: string): Response {
  console.warn(JSON.stringify({ level: "warn", message: "map_tile_unavailable", reason }));
  return new Response("Map tile unavailable", { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

/** `caches.default` on Cloudflare Workers; null elsewhere (Node tests, local e2e server). */
export function edgeCache(): TileCache | null {
  const caches = (globalThis as { caches?: { default?: TileCache } }).caches;
  return caches?.default ?? null;
}
