import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { PublicSiteDto } from "../../src/shared/api-types.ts";
import { isPreviewTile, MAP_PREVIEW_ZOOM, MAP_TILE_SIZE, mapTilePath, previewTiles, tilePoint } from "../../src/shared/map-tiles.ts";
import { rateGroup } from "../../src/worker/security/rate-limit.ts";
import { MapTileService, type TileCache } from "../../src/worker/services/map-tile.service.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

// Phasakura (Mae Win, Mae Wang, Chiang Mai): at zoom 15 the place is in tile 25350 / 14659.
const LAT = 18.6139152;
const LNG = 98.5062681;
const HOME = "/map-tiles/15/25350/14659.png";

describe("map thumbnail tile maths (shared by Worker and client)", () => {
  it("Web Mercator tile coordinates", () => {
    assert.deepEqual(tilePoint(0, 0, 1), { x: 1, y: 1 });
    const p = tilePoint(LAT, LNG, MAP_PREVIEW_ZOOM);
    assert.equal(Math.floor(p.x), 25350);
    assert.equal(Math.floor(p.y), 14659);
  });

  it("the tiles cover a 320 × 160 thumbnail centred on the place, edge to edge", () => {
    const tiles = previewTiles(LAT, LNG);
    assert.ok(tiles.length >= 1 && tiles.length <= 6, `${tiles.length} tiles`);
    assert.ok(tiles.some((t) => mapTilePath(t.x, t.y) === HOME));
    // The point is (0, 0): the union of the tiles must reach 160 px left / right and 80 px up / down.
    const left = Math.min(...tiles.map((t) => t.left));
    const right = Math.max(...tiles.map((t) => t.left + MAP_TILE_SIZE));
    const top = Math.min(...tiles.map((t) => t.top));
    const bottom = Math.max(...tiles.map((t) => t.top + MAP_TILE_SIZE));
    assert.ok(left <= -160 && right >= 160 && top <= -80 && bottom >= 80, JSON.stringify({ left, right, top, bottom }));
    // Neighbours meet exactly (no seams).
    for (const a of tiles) {
      const east = tiles.find((b) => b.y === a.y && b.x === a.x + 1);
      if (east) assert.equal(east.left - a.left, MAP_TILE_SIZE);
      const south = tiles.find((b) => b.x === a.x && b.y === a.y + 1);
      if (south) assert.equal(south.top - a.top, MAP_TILE_SIZE);
    }
  });

  it("wraps at the antimeridian, stays inside the world, rejects bad numbers", () => {
    const n = 2 ** MAP_PREVIEW_ZOOM;
    for (const t of previewTiles(0, 179.9999)) assert.ok(t.x >= 0 && t.x < n);
    assert.ok(previewTiles(0, 179.9999).some((t) => t.x === 0), "east of 180° is column 0");
    for (const t of previewTiles(89, 0)) assert.ok(t.y >= 0 && t.y < n);
    assert.deepEqual(previewTiles(Number.NaN, 0), []);
  });

  it("only the thumbnail's own tiles pass the server-side check", () => {
    assert.equal(isPreviewTile(LAT, LNG, 15, 25350, 14659), true);
    assert.equal(isPreviewTile(LAT, LNG, 14, 12675, 7329), false, "other zoom");
    assert.equal(isPreviewTile(LAT, LNG, 15, 25350, 14670), false, "far away");
    assert.equal(isPreviewTile(LAT, LNG, 15, 0, 0), false);
  });
});

describe("GET /map-tiles/… (OpenStreetMap through the Worker)", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
    h.db.run(`INSERT INTO site_settings (id, default_language, latitude, longitude) VALUES (1, 'th', ${LAT}, ${LNG})
      ON CONFLICT (id) DO UPDATE SET latitude = excluded.latitude, longitude = excluded.longitude`);
  });

  it("serves a tile of the place: PNG, cached 7 days, fetched with an identifying User-Agent and Referer", async () => {
    const res = await h.get(HOME);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "image/png");
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=604800");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())].slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(h.tileRequests.length, 1);
    const call = h.tileRequests[0]!;
    assert.equal(call.url, "https://tile.openstreetmap.org/15/25350/14659.png");
    assert.match(call.headers["user-agent"] ?? "", /^Chomkhao\/1\.0 \(\+https?:\/\/[^)]+\)$/);
    assert.ok(call.headers.referer, "Referer sent");
    assert.ok(!("cookie" in call.headers), "no visitor data upstream");
  });

  it("HEAD answers without a body", async () => {
    const res = await h.get(HOME, {}, "HEAD");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  it("is not an open proxy: other tiles, other zooms, odd paths → 404 without asking OpenStreetMap", async () => {
    for (const path of ["/map-tiles/15/25350/14670.png", "/map-tiles/16/50700/29318.png", "/map-tiles/15/25350/14659.jpg",
      "/map-tiles/15/25350/14659.png/x", "/map-tiles/../media/x.png", "/map-tiles/"]) {
      assert.equal((await h.get(path)).status, 404, path);
    }
    assert.equal(h.tileRequests.length, 0);
    assert.equal((await h.app.fetch(new Request(`https://phasakura.test${HOME}`, { method: "POST" }), h.env)).status, 405);
  });

  it("no coordinates in Settings → 404", async () => {
    h.db.run("UPDATE site_settings SET latitude = NULL, longitude = NULL WHERE id = 1");
    assert.equal((await h.get(HOME)).status, 404);
    assert.equal(h.tileRequests.length, 0);
  });

  it("OpenStreetMap down, an error page, or not a PNG → 502, never cached", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response("busy", { status: 503 }),
      () => new Response("<html>blocked</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      () => new Response(new Uint8Array(400_000).fill(0x89), { status: 200 }),
      () => Promise.reject(new TypeError("network")),
    ];
    for (const answer of answers) {
      h.tileResponse = answer;
      const res = await h.get(HOME);
      assert.equal(res.status, 502);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
    }
  });

  it("tile requests are not rate limited (cacheable files)", () => {
    assert.equal(rateGroup("GET", HOME), null);
  });

  it("the public site data carries the coordinates (both or none)", async () => {
    const site = (await h.api<PublicSiteDto>("GET", "/api/public/site?lang=th")).data;
    assert.deepEqual(site.contact.coordinates, { latitude: LAT, longitude: LNG });
    h.db.run("UPDATE site_settings SET latitude = NULL, longitude = NULL WHERE id = 1");
    assert.equal((await h.api<PublicSiteDto>("GET", "/api/public/site?lang=th")).data.contact.coordinates, null);
  });
});

describe("map tiles: Cloudflare edge cache", () => {
  it("a cached tile is served without the database or OpenStreetMap; the key has no query string", async () => {
    const store = new Map<string, Response>();
    const cache: TileCache = {
      match: async (key) => store.get(key.url)?.clone(),
      put: async (key, res) => { store.set(key.url, res); },
    };
    let upstream = 0;
    let lookups = 0;
    const svc = new MapTileService(async () => { lookups++; return { latitude: LAT, longitude: LNG }; }, {
      cache,
      siteUrl: "https://phasakura.test",
      fetch: async () => { upstream++; return new Response(pngBytes(256, 256)); },
    });
    const url = new URL(`https://phasakura.test${HOME}?v=1`);
    assert.equal((await svc.serve(new Request(url), url)).status, 200);
    assert.deepEqual([...store.keys()], [`https://phasakura.test${HOME}`]);
    const again = await svc.serve(new Request(url), url);
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("Content-Type"), "image/png");
    assert.equal(upstream, 1);
    assert.equal(lookups, 1);
  });
});
