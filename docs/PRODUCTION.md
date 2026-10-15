# Chomkhao — Production Runbook

คู่มือนำระบบขึ้นใช้งานจริงและดูแลหลังเปิด (Phase 16) — ใช้คู่กับ `README.md` (ขั้นตอนตั้งค่า LINE / GA4 / Meta อย่างละเอียด)

เครื่องมือในโปรเจกต์:

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run preflight` | ตรวจไฟล์ตั้งค่าก่อน deploy (โดเมน, D1, cron, rate limit, migration, secret ใน Git) — อ่านไฟล์อย่างเดียว ไม่ต่อเน็ต |
| `npm run preflight -- --secrets secrets.json` | ตรวจด้วยว่า secret ไหนตั้งแล้ว (อ่านเฉพาะ **ชื่อ** จาก `npx wrangler secret list > secrets.json`, ลบไฟล์หลังใช้) |
| `npm run db:backup` | จด Time Travel bookmark + export D1 ไป `backups/` พร้อม SHA-256 |
| `npm run release` | preflight → backup → migrate (remote) → build → deploy |
| `npm run smoke -- https://www.โดเมน` | Smoke test หลัง deploy (อ่านอย่างเดียว) |
| Admin → **สถานะระบบ** | ความพร้อม 19 ข้อ, health, งานเบื้องหลัง (cron), งานค้าง, ข้อผิดพลาดล่าสุด (สิทธิ์ `system.view`: SUPER_ADMIN, MANAGER) |
| `GET /api/health` | สำหรับ Uptime monitor: 200 = ปกติ, 503 = ฐานข้อมูล / schema / cron มีปัญหา |

## สถานะ chomkhao.com (อัปเดต 2026-10-14)

Chomkhao คัดลอกมาจากโค้ด Phasakura (ประวัติ Git เดิมยังอยู่ — ดึงการแก้ไขจาก Phasakura มาได้ ดูหัวข้อ "รับการแก้ไขจาก Phasakura")
ใช้บัญชี Cloudflare เดียวกัน แต่ Worker, D1, R2, secret และข้อมูลแยกกันทั้งหมด — ไม่มีข้อมูลการจอง / ลูกค้าของ Phasakura ติดมา

| รายการ | สถานะ |
|---|---|
| โดเมน `chomkhao.com` | zone อยู่บน Cloudflare แล้ว — Custom Domain (apex + www) สร้าง DNS / ใบรับรองให้ตอน deploy ครั้งแรก (www → 301 ไป apex) |
| D1 `chomkhao-db` | สร้างแล้ว 2026-10-14 (APAC, id `227e945a-ca93-4749-a92a-08c959bb3485`) — schema ครบ 0001–0026 (94 ตาราง, 101 index, 44 trigger) + ข้อมูลตั้งต้น (ภาษา, บทบาท, สิทธิ์, ค่าตั้งต้น) ตรวจด้วย fingerprint เทียบกับไฟล์ migration ตรงกันทุกไบต์ (schema 95,712 bytes, seed 13,617 bytes), `d1_migrations` 26 แถว — ฐานข้อมูลว่าง ไม่มีการจอง / ที่พัก |
| R2 | `chomkhao-media-public`, `chomkhao-media-private` สร้างแล้ว 2026-10-14 |
| `wrangler.jsonc` | `name: chomkhao`, `APP_BASE_URL=https://chomkhao.com`, routes `chomkhao.com` + `www.chomkhao.com`, rate limit `namespace_id` 2001–2004 (Phasakura ใช้ 1001–1004 ในบัญชีเดียวกัน), `workers_dev: false` — `npm run preflight` 0 error |
| SUPER_ADMIN คนแรก | `suriya.rth@gmail.com` (รหัสผ่านชั่วคราว — ต้องเปลี่ยนตอนเข้าครั้งแรก) |
| โค้ด | GitHub `nujtee/Chomkhao` (branch `main`) |
| Worker | มี Worker ชื่อ `chomkhao` (Hello world) สร้างไว้แล้ว — deploy แรกจาก Workers Builds จะแทนที่ |
| Deploy | **Workers Builds** — ต้องเชื่อม repo ครั้งเดียว (หัวข้อถัดไป); หลังจากนั้นทุก push เข้า `main` จะ build + deploy อัตโนมัติ |
| Secrets | ยังไม่ได้ตั้ง — ใช้บัญชีของ Chomkhao เอง (LINE OA, EasySlip, Zoho Mail, PayPal, Meta, GA4) ไม่ใช้ร่วมกับ Phasakura (ข้อ 4) |
| Workers Paid | บัญชีเดียวกับ Phasakura |

### เชื่อม GitHub → Cloudflare (ครั้งเดียว)

Dashboard → **Workers & Pages** → Worker **`chomkhao`** → **Settings** → **Build** → **Connect** → GitHub → เลือก `nujtee/Chomkhao`
(หรือ **Create application** → **Import a repository** ถ้ายังไม่มี Worker ชื่อนี้)

| ช่อง | ค่า |
|---|---|
| Project name | `chomkhao` (ต้องตรงกับ `name` ใน wrangler.jsonc) |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

กด **Save and Deploy** — build ครั้งแรก ~2–4 นาที แล้ว `https://chomkhao.com` ใช้งานได้

### Migration ครั้งต่อไป

API token อัตโนมัติของ Workers Builds **ไม่มีสิทธิ์ D1** จึงไม่ migrate เอง: ก่อน push โค้ดที่มี migration ใหม่ ให้รัน
`npm run db:backup && npm run db:migrate:remote` (หรือให้ Claude apply ผ่าน D1) แล้วค่อย push

### ระบบเครดิตการใช้ App (migration 0027)

- **0027 เป็น DESTRUCTIVE rebuild ของตาราง `bookings`** (เพิ่มคอลัมน์ค่าธรรมเนียม) — `npm run db:backup` ก่อนเสมอ
  ย้อนกลับได้ด้วยไฟล์ backup นั้น โค้ดใหม่ทำงานได้ทั้งก่อนและหลัง apply (ก่อน apply ระบบเครดิตจะปิดอยู่)
- หลัง apply ระบบยัง **ปิด** อยู่ — การจองเหมือนเดิมทุกอย่าง จนกว่า Super Admin จะเปิด
- ขั้นตอนเปิดใช้ (Super Admin): หลังบ้าน → การเงิน → **จัดการเติมเครดิต** → ตั้งค่า: บัญชีรับเงิน / พร้อมเพย์ / QR,
  อีเมลรับแจ้ง, ค่าธรรมเนียมต่อหลัง (ค่าเริ่มต้น 20), ยอดขั้นต่ำ Standard / Premium, โหมดอนุมัติ (เอง / EasySlip —
  ต้องตั้ง `SLIP_VERIFY_PROVIDER` + `SLIP_VERIFICATION_API_KEY` ก่อน) → เพิ่มเครดิตตั้งต้นในแท็บยอดคงเหลือ → เปิดระบบ
- ผู้ใช้หลังบ้านแต่ละคนผูก LINE ของตัวเองได้ที่ **บัญชีของฉัน** (มุมขวาบน) เพื่อรับแจ้งเตือนเครดิตทาง LINE
- Phasakura ไม่ได้รับผลกระทบ (คนละ repo / คนละฐานข้อมูล) ถ้า merge โค้ดนี้ไปที่นั่น ระบบก็ปิดอยู่จนกว่าจะเปิดเอง

### รับการแก้ไขจาก Phasakura

โค้ดสองเว็บเหมือนกัน ต่างกันแค่ค่าตั้ง (`wrangler.jsonc`, `package.json`), ข้อความชื่อเว็บไม่กี่จุด และเอกสาร
(ตัวระบุภายใน เช่น header `X-Requested-With: phasakura` และชื่อ key ใน localStorage คงไว้เหมือนเดิมโดยตั้งใจ เพื่อให้รวมการแก้ไขได้ง่าย)

```bash
git remote add upstream https://github.com/nujtee/Phasakura.git   # ครั้งเดียว
git fetch upstream && git merge upstream/main                      # แก้ conflict เฉพาะไฟล์ค่าตั้ง / เอกสาร
```

ถ้าการแก้ไขนั้นมี migration ใหม่ ต้อง apply ลง `chomkhao-db` ก่อน push (เหมือนหัวข้อด้านบน)

---

## 1. สิ่งที่ต้องมีก่อน

1. **Cloudflare Workers Paid plan** (จำเป็น) — แผนฟรีให้ CPU 10 ms ต่อ request และต่อรอบ cron ซึ่งไม่พอสำหรับ
   การเข้ารหัสรหัสผ่าน (PBKDF2 100,000 รอบ), รายงาน Excel และงาน cron ทุกนาที; แผน Paid ได้ 30 วินาที,
   D1 Time Travel 30 วัน (ฟรี 7 วัน) และ Workers Logs 7 วัน (ฟรี 3 วัน)
2. โดเมนอยู่บน Cloudflare (เปลี่ยน nameserver แล้ว, zone สถานะ Active) และ **ยังไม่มี CNAME** ของ hostname ที่จะใช้
3. เปิด 2FA ให้บัญชี Cloudflare, LINE Developers, Google และ Meta ที่ใช้กับเว็บ
4. ที่เก็บรหัสลับ (password manager) — secret ที่ใส่ใน Cloudflare แล้ว **อ่านกลับไม่ได้** ต้องเก็บต้นฉบับเอง

## 2. ติดตั้งครั้งแรก

```bash
npm ci
npx wrangler login

# D1 (ใกล้ผู้ใช้ในไทย: apac) → คัด database_id ไปใส่ wrangler.jsonc
npx wrangler d1 create chomkhao-db --location=apac

# R2: สอง bucket — ห้ามเปิด Public access / r2.dev ของ bucket private (สลิปโอนเงิน)
npx wrangler r2 bucket create chomkhao-media-public
npx wrangler r2 bucket create chomkhao-media-private
```

แก้ `wrangler.jsonc`:

- `d1_databases[0].database_id` ← id จริง
- `vars.APP_BASE_URL` ← โดเมนหลักแบบ `https://www.your-domain.com` (ไม่มี `/` ท้าย) — ใช้กับ canonical, sitemap,
  ลิงก์ตั้งรหัสผ่าน, ข้อความ LINE; โดเมนอื่นที่เข้ามาถึง Worker (เช่น apex) จะถูก **301** ไปที่นี่อัตโนมัติ
- เปิดบล็อก `routes` (ใส่ทั้ง `www` และ apex แบบ `custom_domain: true`) และ `"workers_dev": false`
- `preview_urls` คง `false` ไว้ (ไม่งั้น version ใหม่จะมี URL สาธารณะที่ใช้ D1 / R2 จริง)
- ถ้าบัญชีมี Worker อื่นใช้ rate-limit `namespace_id` 1001–1004 อยู่แล้ว ให้เปลี่ยนเป็นเลขอื่นที่ไม่ซ้ำ

ตั้ง secret เฉพาะที่ใช้ (ดูตารางข้อ 4) แล้ว:

```bash
npm run preflight                       # ต้อง 0 error
npm run db:migrate:remote               # สร้างตารางทั้งหมด (0001–0020)
npm run admin:bootstrap -- --email owner@your-domain.com --name "Owner" --out bootstrap.sql
npx wrangler d1 execute chomkhao-db --remote --file bootstrap.sql
rm bootstrap.sql                        # มี hash รหัสผ่าน — ห้าม commit (อยู่ใน .gitignore แล้ว)
npm run deploy                          # preflight + build + wrangler deploy
npm run smoke -- https://www.your-domain.com
```

จากนั้นเข้า `/th/admin` → เปลี่ยนรหัสผ่านชั่วคราว → ตั้งค่าตามลำดับ: Settings → Website (ชื่อเว็บ, ภาษา),
Branding, Theme, บัญชีรับเงิน (ตั้ง **บัญชีหลัก** — ไม่มีแล้วจองไม่ได้), ที่พัก/ราคา, อาหาร, Privacy (ก่อนเปิด GA4 / Pixel),
แล้ว **สร้าง SUPER_ADMIN คนที่สอง** (ระบบไม่มีรีเซ็ตทางอีเมล) — สุดท้ายเปิด Admin → สถานะระบบ ให้ไม่มีรายการ "ต้องแก้"

## 3. โดเมนและ SSL

| ที่ | ตั้งค่า |
|---|---|
| `wrangler.jsonc` → `routes` | `{ "pattern": "www.your-domain.com", "custom_domain": true }` และ apex — Cloudflare สร้าง DNS record และใบรับรอง TLS ให้เอง |
| SSL/TLS → Edge Certificates | **Always Use HTTPS: On** (smoke test ตรวจ http→https), **Minimum TLS Version: 1.2** |
| HSTS | แอปส่ง `Strict-Transport-Security: max-age=31536000; includeSubDomains` เองแล้ว — `includeSubDomains` หมายถึง **ทุก subdomain ต้องใช้ https ได้**; ไม่ต้องเปิด preload |
| SSL/TLS mode | ไม่มีผลกับ Worker (Cloudflare เป็นปลายทางเอง); ถ้า zone มี origin อื่นให้ใช้ Full (strict) |
| `workers_dev` / `preview_urls` | `false` ทั้งคู่เมื่อโดเมนใช้งานได้ |

## 4. Secrets (Cloudflare Secrets เท่านั้น — ห้ามอยู่ใน Git, D1, frontend, log)

```bash
npx wrangler secret put <NAME>      # ตั้ง / หมุนค่าใหม่ (มีผลทันที ไม่ต้อง deploy)
npx wrangler secret delete <NAME>
npx wrangler secret list            # ดูได้แค่ชื่อ
```

| Secret | ต้องมีเมื่อ |
|---|---|
| `SLIP_VERIFICATION_API_KEY` | ตั้ง `SLIP_VERIFY_PROVIDER` (เช่น `easyslip`) — ไม่ตั้ง = พนักงานตรวจสลิปเองทุกใบ (ระบบไม่ใช้ OCR อย่างเดียว) |
| `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` | เปิด LINE (Admin → Settings → LINE) |
| `META_CAPI_ACCESS_TOKEN` | เปิด Conversions API |
| `META_PIXEL_ID` | ไม่บังคับ (ทับ Pixel ID ใน Admin สำหรับ CAPI) |
| `META_TEST_EVENT_CODE` | ช่วงทดสอบเท่านั้น — **ลบหลังทดสอบ** (สถานะระบบเตือนถ้ายังอยู่ใน production) |
| `GA4_SERVICE_ACCOUNT_KEY` | ตัวเลข GA4 บน Dashboard (ใส่ property ID ใน Admin → Marketing → GA4) |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` | อีเมลแจ้งเตือนจากกล่อง Zoho Mail ของร้าน (Admin → ตั้งค่า → อีเมลแจ้งเตือน) — วิธีสร้างดูหัวข้อ "อีเมลผ่าน Zoho Mail" ด้านล่าง |
| `ZOHO_REGION` | ไม่บังคับ: data center ของ Zoho ถ้าไม่ใช่ US (`eu`, `in`, `com.au`, `jp`, `ca`, `sa`) — ดูจากโดเมนตอน login Zoho Mail |
| `RESEND_API_KEY` | ไม่บังคับ: ส่งผ่าน Resend แทน (ใช้เฉพาะเมื่อยังไม่ได้ตั้ง Zoho) — ต้องยืนยันโดเมนผู้ส่งใน Resend |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal Checkout (Admin → การเงิน → ตั้งค่าการชำระเงิน) — PayPal Developer → Apps & Credentials → สร้าง REST app (Live) |
| `PAYPAL_ENV` | ไม่บังคับ: `sandbox` เฉพาะตอนทดสอบด้วย credentials ของ sandbox (ไม่ตั้ง = PayPal จริง) |

`SLIP_VERIFICATION_API_KEY` อย่างเดียว (ไม่ตั้ง `SLIP_VERIFY_PROVIDER`) = ใช้ EasySlip — **อย่าเปิด IP whitelist ใน EasySlip**
(Cloudflare Workers ไม่มี IP ขาออกคงที่) โหมด Auto / Manual approve เลือกใน Admin → การเงิน → ตั้งค่าการชำระเงิน

### อีเมลผ่าน Zoho Mail

ส่งจากกล่อง Zoho Mail ของโดเมน (เช่น booking@chomkhao.com) ผ่าน Zoho Mail API — SPF / DKIM ของ Zoho ที่ตั้งไว้แล้ว
ครอบคลุมอยู่ ไม่ต้องเพิ่ม DNS

1. login https://api-console.zoho.com ด้วยบัญชีของกล่องที่จะใช้ส่ง → **Self Client** → CREATE → คัด Client ID / Client Secret
2. แท็บ **Generate Code**: Scope `ZohoMail.messages.CREATE,ZohoMail.accounts.READ`, Time Duration 10 minutes → CREATE → คัด code
3. แลก code เป็น refresh token ภายในเวลาที่เลือก (data center อื่นเปลี่ยน `accounts.zoho.com` ตามโดเมนของ Zoho):
   ```bash
   curl -s -X POST https://accounts.zoho.com/oauth/v2/token \
     -d grant_type=authorization_code -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET -d code=CODE
   ```
   คำตอบมี `"refresh_token"` (ไม่หมดอายุ) — ถ้าได้ `"error":"invalid_code"` แปลว่า code หมดเวลา/ใช้ไปแล้ว ให้สร้างใหม่
4. `wrangler secret put ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` (และ `ZOHO_REGION` ถ้าไม่ใช่ US)
5. Admin → ตั้งค่า → อีเมลแจ้งเตือน: ต้องขึ้น "✓ Zoho Mail" → อีเมลผู้ส่ง = อีเมลของกล่องนั้น (หรือ alias) → เพิ่มอีเมลเจ้าหน้าที่ → "ส่งทดสอบ"

ข้อจำกัด: Zoho จำกัดการส่งออกนอกโดเมน 50–500 ฉบับ/ชั่วโมง (ปรับตามชื่อเสียงผู้ส่ง) และ API 30 ครั้ง/นาที — เกินแล้ว
ระบบรอและส่งใหม่เอง; ชื่อผู้ส่งใช้ display name ของกล่อง Zoho; ไม่มี Reply-To (ลูกค้าตอบกลับมาที่อีเมลผู้ส่ง);
ฉบับที่ส่งจะอยู่ในโฟลเดอร์ Sent ของกล่องนั้น ถ้าต้องการยกเลิกสิทธิ์: api-console.zoho.com → ลบ Self Client
แล้ว `wrangler secret delete` ทั้งสามค่า

ถ้าสงสัยว่า secret รั่ว: สร้างค่าใหม่ที่ผู้ให้บริการ (LINE: reissue channel secret / token, Meta: generate token ใหม่,
Google: สร้าง key ใหม่แล้วลบ key เก่า) → `wrangler secret put` → ตรวจด้วย "Check connection" / "Send test event"

## 5. LINE, GA4, Meta, Search Console

รายละเอียดอยู่ใน `README.md` (หัวข้อ LINE notifications และ Cookie consent, GA4, Meta Pixel…) สรุปสิ่งที่ต้องทำใน production:

- **LINE**: Webhook URL = `https://www.your-domain.com/api/line/webhook` (คัดจาก Admin → LINE), เปิด "Use webhook",
  กด Check connection, ผูกแชตพนักงานด้วยรหัส; ถ้าเปิด Bot Fight Mode ของ Cloudflare ให้กด Check connection อีกครั้ง
  (webhook เป็น server-to-server)
- **GA4**: Measurement ID ใน Admin; ปิด "Page changes based on browser history events" ใน Enhanced measurement
- **Meta Pixel**: ปิด "Automatic advanced matching"; ทดสอบ CAPI ด้วย Test events แล้วลบ `META_TEST_EVENT_CODE`
- **Search Console**: Domain property ยืนยันด้วย DNS TXT (แนะนำ) แล้ว Submit `https://www.your-domain.com/sitemap.xml`;
  ตรวจ URL Inspection หน้าแรกทั้ง 3 ภาษา
- เขียน **นโยบายความเป็นส่วนตัว** (Settings → Privacy) ก่อนเปิด GA4 / Pixel — banner คุกกี้ขึ้นเองเมื่อเปิด tracker
- **แผนที่ย่อท้ายเว็บ**: ใส่ ละติจูด / ลองจิจูด ใน Settings → Website (ลิงก์แผนที่ = ปลายทางเมื่อคลิก) แผนที่เป็นภาพ
  OpenStreetMap ที่ Worker ดึงผ่าน `/map-tiles/…` (เบราว์เซอร์ผู้เข้าชมไม่ติดต่อบุคคลที่สาม, cache ที่ edge 7 วัน,
  ให้เฉพาะ tile รอบพิกัดของที่พัก) — ถ้าดึงไม่ได้ ภาพจะซ่อนเอง เหลือคำว่า "แผนที่" ที่คลิกได้

## 6. Backup & restore

**อะไรถูกเก็บที่ไหน**

| ข้อมูล | Backup |
|---|---|
| D1 (การจอง, การชำระเงิน, ผู้ใช้, เนื้อหา, ตั้งค่า) | **Time Travel อัตโนมัติ** ย้อนได้ทุกนาที 30 วัน (Paid) + `npm run db:backup` (export SQL) |
| R2 private (สลิปโอนเงิน = หลักฐานการชำระ) | ไม่มี Time Travel — สำรองด้วย rclone (ด้านล่าง) |
| R2 public (รูปภาพ) | สำรองด้วย rclone (อัปโหลดใหม่ได้แต่เสียเวลา) |
| Secrets | ต้นฉบับใน password manager |
| โค้ด / migration | Git |

**ทำเมื่อไร**: ก่อนทุก migration / deploy (`npm run release` ทำให้แล้ว), สัปดาห์ละครั้ง (`npm run db:backup`),
และ **ซ้อมกู้คืนเดือนละครั้ง** ลงฐานข้อมูลทดลอง

- Export ระหว่างทำงานจะ **บล็อก query อื่นของฐานข้อมูล** — ทำช่วงคนใช้น้อย
- ไฟล์ export มีข้อมูลส่วนบุคคลของแขกและ hash รหัสผ่าน: เก็บแบบเข้ารหัส, ห้าม commit (`backups/` อยู่ใน .gitignore)

**กู้คืน D1**

```bash
# A) ย้อนเวลา (ภายใน 30 วัน) — ทับฐานข้อมูลเดิม, query ที่กำลังทำงานถูกยกเลิก, ข้อมูลหลังเวลานั้นหาย
npx wrangler d1 time-travel info chomkhao-db --timestamp="2027-01-10T03:00:00+07:00"   # ดู bookmark ของเวลานั้น
npm run db:backup                                                                      # เก็บสถานะปัจจุบันไว้ก่อนเสมอ
npx wrangler d1 time-travel restore chomkhao-db --bookmark=<bookmark>
# คำสั่ง restore คืน bookmark ก่อนกู้ — ใช้ย้อนกลับได้ถ้ากู้ผิดจุด

# B) จากไฟล์ export (ฐานข้อมูลใหม่แล้วสลับ)
npx wrangler d1 create chomkhao-restore --location=apac
npx wrangler d1 execute chomkhao-restore --remote --file backups/chomkhao-db-YYYYMMDDTHHMMSSZ.sql
npx wrangler d1 migrations list chomkhao-restore --remote     # ต้องไม่มี migration ค้าง
# ตรวจข้อมูล → ใส่ database_id ใหม่ใน wrangler.jsonc → npm run deploy
```

หลังกู้: การจองที่เกิดหลังจุดกู้คืนต้องตรวจกับสลิป / LINE log / อีเมลด้วยมือ แล้วบันทึกใหม่

**R2 ด้วย rclone**: R2 → Manage R2 API Tokens → สร้าง token แบบ *Object Read only* เฉพาะ 2 bucket →
ตั้ง remote ชนิด S3 provider Cloudflare ใน rclone → `rclone sync r2:chomkhao-media-private <ที่เก็บเข้ารหัส>/slips`
และ `rclone sync r2:chomkhao-media-public <ที่เก็บ>/media` (สัปดาห์ละครั้ง)

## 7. Monitoring

| สัญญาณ | ดูที่ไหน | ทำอะไร |
|---|---|---|
| เว็บล่ม / ฐานข้อมูล / schema / cron | Uptime monitor (บริการใดก็ได้) เรียก `https://www.your-domain.com/api/health` ทุก 1–5 นาที แจ้งเตือนเมื่อไม่ใช่ 200 | ดูตารางเหตุขัดข้องข้อ 9 |
| ความพร้อม, งานค้าง, cron, error 24 ชม. | Admin → สถานะระบบ (ดูทุกเช้า) | ทำตามข้อความ "วิธีแก้" ของแต่ละรายการ |
| ข้อผิดพลาดของเซิร์ฟเวอร์ | Admin → สถานะระบบ → ข้อผิดพลาดล่าสุด (เก็บ 30 วัน) และ Cloudflare → Workers & Pages → chomkhao → Observability / Logs (7 วัน, ค้นด้วย Request ID) | Request ID เดียวกันอยู่ใน header `X-Request-Id` ของทุก API response |
| ส่ง LINE / CAPI ไม่สำเร็จ | Settings → LINE → Delivery log, Marketing → CAPI | ตรวจ secret / token หมดอายุ แล้ว Retry |
| การเข้าสู่ระบบผิดปกติ, rate limit | Administration → Security events | ระงับผู้ใช้ / บังคับออกจากระบบ |
| ใครแก้อะไร | Administration → Audit logs | — |
| การใช้งาน / โควตา | Cloudflare → Workers & Pages / D1 → Metrics | ขนาด D1, จำนวน request |

`/api/health` ตอบ `{"status","database","schema","cron","time"}` เท่านั้น (ไม่มีข้อมูลตั้งค่า):
`schema: outdated` = ยังไม่ได้ migrate, `cron: stale` = cron ไม่ทำงานเกิน 5 นาที (การจองค้างจะไม่หมดเวลา,
LINE / CAPI ไม่ถูกส่ง), `cron: unknown` = ยังไม่เคยทำงาน (ปกติในนาทีแรกหลัง deploy ครั้งแรก)

## 8. Error logging — อะไรถูกบันทึก

- **Workers Logs**: ทุก `console` ของ Worker เป็น JSON (`level`, `message`, `requestId`) — ไม่มีรหัสผ่าน, token, secret
- **error_events (D1)**: เฉพาะ error ที่ไม่คาดคิด (HTTP 500, หน้าเว็บที่ต้องแสดงแบบลดรูป, งาน cron ล้ม) — เก็บ method + path
  (ไม่มี query string), ชื่อ error และข้อความที่ลบอีเมล / เบอร์โทร / token ออกแล้ว, สูงสุด 20 รายการ/นาที/instance, ลบอัตโนมัติหลัง 30 วัน
- **system_heartbeats**: cron ทุกนาทีบันทึกเวลา, ระยะเวลา, งานที่ล้ม
- **security_events / audit_logs**: ตามเดิม (Phase 3, 14)

## 9. เหตุขัดข้องและการแก้

| อาการ | ทำ |
|---|---|
| Deploy ใหม่แล้วพัง | `npx wrangler rollback` (กลับไป version ก่อนหน้า) — migration ที่ apply แล้วไม่ถูกย้อน แต่ทุก migration เป็นแบบเพิ่ม โค้ดเก่าทำงานต่อได้ |
| `/api/health` 503, `schema: outdated` | `npm run db:backup` แล้ว `npm run db:migrate:remote` |
| `cron: stale` | Cloudflare → Worker → Settings → Triggers: ต้องมี `* * * * *`; ดู Logs ของ cron; ดู "งานเบื้องหลัง" ในสถานะระบบว่างานไหนล้ม |
| `database: unavailable` | ดู https://www.cloudflarestatus.com และ Logs |
| แผนที่ย่อท้ายเว็บไม่ขึ้น | ตรวจว่ามี ละติจูด / ลองจิจูด ใน Settings → Website; Logs ค้น `map_tile_unavailable` (เหตุจาก tile.openstreetmap.org) |
| ข้อมูลผิด / ถูกลบ | หยุดแก้ไขเพิ่ม → `npm run db:backup` → Time Travel ไปก่อนเกิดเหตุ (ข้อ 6) |
| Secret รั่ว | หมุนค่าใหม่ทันที (ข้อ 4), ดู Audit / Security events |
| บัญชีแอดมินถูกใช้ผิด | SUPER_ADMIN อีกคนระงับบัญชีนั้น (ระงับ = ตัดทุก session) แล้วตรวจ Audit logs |
| SUPER_ADMIN ลืมรหัสทุกคน | `npm run admin:bootstrap` ใช้ไม่ได้ถ้ายังมี SUPER_ADMIN ที่ ACTIVE — ให้ SUPER_ADMIN อีกคนรีเซ็ต (จึงต้องมี ≥ 2 คน) |

## 10. ทุกครั้งที่อัปเดต (release)

```bash
git pull && npm ci
npm run check                           # typecheck, lint, static checks, unit tests
npm run test:e2e                        # (แนะนำ) browser suites
npm run release                         # preflight → backup → migrate → build → deploy
npm run smoke -- https://www.your-domain.com
```

แล้วเปิด Admin → สถานะระบบ ดูว่า "Database up to date" และ cron ปกติ

## 11. Final smoke test (ครั้งแรกก่อนประกาศเปิด)

1. `SMOKE_ADMIN_IDENTIFIER=… SMOKE_ADMIN_PASSWORD=… npm run smoke -- https://www.your-domain.com` → 0 error
   (ตั้งตัวแปรใน environment เท่านั้น ห้ามพิมพ์รหัสผ่านใน command line)
2. เปิดเว็บบนมือถือและคอมพิวเตอร์ ทั้ง TH / EN / 中文 — เมนู, รูป, ฟอนต์, ปุ่มจอง, banner คุกกี้
3. จองจริง 1 รายการ (ราคาต่ำสุด) → ดู QR / บัญชีรับเงิน → อัปโหลดสลิป → ตรวจใน Admin → ยืนยัน
   → LINE แจ้งพนักงาน → GA4 Realtime / Meta Test events เห็น Purchase ครั้งเดียว → ยกเลิกการจองทดสอบ
4. ค้นหาการจองด้วย Booking ID + เบอร์โทร
5. Search Console: URL Inspection หน้าแรก → "URL is available to Google"
6. Uptime monitor แจ้งเตือนได้จริง (ลองหยุดชั่วคราวหรือใช้ปุ่ม test ของบริการ)
7. ทำ `npm run db:backup` ครั้งแรก และซ้อมกู้คืนลงฐานข้อมูลทดลอง
