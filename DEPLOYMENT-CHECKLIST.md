# CRM Salam Fortress Deployment Checklist

Panduan ini untuk publish `CRM Salam Fortress` ke domain sebenar, hidupkan webhook, dan map lead flow untuk:

- Salam Land Development
- Bumi Hayat Printing
- Barakah Emas

## 0. Pre-launch Production Gate (wajib)

Status mesti kekal `HOLD` dan deployment tidak boleh dimulakan sehingga semua item ini disahkan:

- [ ] all verification commands exit 0, termasuk:

```bash
node --check server.js
node --check app.js
node --check scripts/smoke-lead-ingestion-guards.mjs
node --check scripts/smoke-stabilize-sales-production.mjs
node --check scripts/production-package-audit.mjs
node scripts/smoke-lead-ingestion-guards.mjs
node scripts/smoke-stabilize-sales-production.mjs
node scripts/production-package-audit.mjs --dry-run
git diff --check
```

- [ ] fresh production backup exists dan timestamp/path telah direkod sebelum sebarang perubahan production.
- [ ] exact rollback snapshot exists dan arahan restore telah disahkan untuk snapshot tersebut.
- [ ] signature envs configured: `NODE_ENV=production`, `CRM_REQUIRE_WEBHOOK_SIGNATURES=true`, dan `META_APP_SECRET` mempunyai secret deployment sebenar.
- [ ] unsigned webhook overrides disabled: `META_ALLOW_UNSIGNED_WEBHOOKS=false` dan `TIKTOK_ALLOW_UNSIGNED_WEBHOOKS=false`.
- [ ] TikTok callback token changed from `crm-salam-fortress-tiktok` kepada token unik deployment dalam CRM integration settings.
- [ ] Clean Package Contract dalam `PRODUCTION-PACKAGE.md` disahkan; runtime/auth/uploads, backup, exports, handoff dan real `.env` tidak termasuk dalam package.
- [ ] strict hardening allowlist hanya mengandungi `server.js`, target-checked config/env documentation, dua smoke scripts, audit script dan dua release docs.
- [ ] `ecosystem.config.cjs` tepat untuk process `crm-salamland-my`, cwd `/var/www/crm.salamland.my`, host `127.0.0.1` dan port `8877`.
- [ ] hardening server scope tidak mengandungi public lead route, Meta backfill route, password change/reset atau forced password migration/setup flow.
- [ ] deployment tidak menggunakan `rsync --delete` dan tidak memadam live-only diagnostic/QA scripts.

Dry-run audit hanya mengesahkan contract source/config/docs. Ia tidak membuktikan secret runtime, backup production atau rollback snapshot sebenar sudah tersedia; ketiga-tiganya mesti disahkan berasingan sebelum approval deploy.

Hardening-only release ini tidak menggantikan `app.js`, `index.html`, `styles.css`, `privacy.html`, `sw.js` atau `assets/**`. Ia juga tidak membawa operational register/cleanup/repair/configure/backfill scripts.

## 1. Server mode

Kalau belum ada setup production penuh, rujuk juga:

- `PRODUCTION-PACKAGE.md`
- `ecosystem.config.cjs`
- `nginx.crm-salam-fortress.conf.example`
- `.env.production.example`

Dalam server:

```bash
cd "/Users/afiq/Documents/New project/agency-crm"
node server.js
```

Kalau nak tukar host/port:

```bash
HOST=0.0.0.0 PORT=8765 node server.js
```

## 2. Domain & HTTPS

- Point domain atau subdomain contoh `crm.yourdomain.com`
- Pastikan reverse proxy bagi `HTTPS`
- Pastikan callback webhook boleh dicapai dari luar
- Set `Public base URL` dalam menu `Integrations`

## 3. Endpoint penting

- Health: `/api/health`
- State: `/api/state`
- Integrations: `/api/integrations`
- Gold rates: `/api/rates/gold`
- Meta webhook: `/api/webhooks/meta`
- TikTok webhook: `/api/webhooks/tiktok`
- WhatsApp Cloud API webhook: `/api/webhooks/whatsapp`

## 4. Sebelum connect ads

- Buat semua campaign yang nak dipakai dalam CRM dulu
- Tentukan staff default setiap company
- Tentukan status awal lead
- Tentukan form mana masuk ke company mana

## 5. Mapping company

### Salam Land Development

Disyorkan:

- Source utama: `Meta Ads`, `TikTok Ads`, `TikTok Live`
- Staff default: ikut round-robin manual atau pilih `Nurin` sebagai default awal
- Status awal: `New Lead`
- Campaign mapping: ikut project atau lokasi

Field wajib form:

- `full_name`
- `phone_number`
- `jenis_tanah`
- `lokasi / project`
- `bajet`
- `bumi / non-bumi`

Struktur cadangan:

- Satu form untuk `Semenyih`
- Satu form untuk `Hulu Langat`
- Satu form untuk `JV / siap geran`

### Bumi Hayat Printing

Disyorkan:

- Source utama: `Meta Ads`, `TikTok Ads`
- Staff default: `Amy`
- Status awal: `New Lead`
- Campaign mapping: ikut kategori katalog

Field wajib form:

- `full_name`
- `phone_number`
- `kategori produk`
- `quantity`
- `customer_type`
- `deadline`
- `design_status`

Struktur cadangan:

- Satu form untuk `Futsal / Rumah Sukan`
- Satu form untuk `Korporat / Windbreaker`
- Satu form untuk `Bulk school / branch`

### Barakah Emas

Disyorkan:

- Source utama: `Meta Ads`, `TikTok Ads`
- Staff default: `Nabilah`
- Status awal: `New Lead`
- Campaign mapping: ikut `916`, `999`, `trade-in`, `survey`

Field wajib form:

- `full_name`
- `phone_number`
- `jenis_transaksi`
- `jenis_emas`
- `range_umur`
- `gram / target gram`

Struktur cadangan:

- Satu form untuk `Emas 916`
- Satu form untuk `Survey harga`
- Satu form untuk `Trade-in`

Gold rate layer:

- Dashboard akan auto tarik `XAU spot (USD)` + `USD/MYR`
- Sistem kira `Emas 999 / g` dan `Emas 916 / g` secara automatik
- Rate ini sesuai sebagai `harga rujukan pasaran`, bukan final harga retail
- Simpan snapshot harga semasa order bila nak guna untuk audit kemudian

## 6. Meta Ads setup

Dalam CRM:

- hidupkan `Meta connection`
- isi `Meta Page ID`
- isi `Meta form IDs`
- pilih `Meta default campaign`
- isi `Meta page access token`
- pilih `Meta default staff`
- pilih `Meta default lead status`

Dalam Meta:

- set callback URL ke `https://your-domain.com/api/webhooks/meta`
- set verify token sama seperti dalam CRM
- subscribe event leadgen untuk Page yang betul

## 7. TikTok Ads setup

Dalam CRM:

- hidupkan `TikTok connection`
- isi `TikTok advertiser ID`
- isi `TikTok form IDs`
- pilih `TikTok default campaign`
- pilih `TikTok lead mode`
- isi `TikTok callback token`
- pilih `TikTok default staff`
- pilih `TikTok default lead status`

Dalam TikTok:

- set callback URL ke `https://your-domain.com/api/webhooks/tiktok`
- pastikan signing / callback secret sepadan
- test webhook event sekali sebelum launch sebenar

## 8. Lepas webhook hidup

Semak perkara ini:

- lead baru masuk tanpa duplicate
- source masuk betul
- campaign masuk betul
- staff assign betul
- status awal betul
- tarikh created ikut hari sebenar Malaysia
- record muncul dalam dashboard dan PDF report

## 8.1 WhatsApp Cloud API setup

Dalam server ENV / PM2:

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_WABA_ID`
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `WHATSAPP_DEFAULT_TEMPLATE_NAME`
- `WHATSAPP_DEFAULT_LANGUAGE_CODE=ms`

Dalam Meta WhatsApp webhook:

- Callback URL: `https://crm.salamland.my/api/webhooks/whatsapp`
- Verify token: sama dengan `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- Subscribe field: `messages`

Dalam CRM:

- Login admin
- `Integrations > WhatsApp API`
- `Open WhatsApp settings`
- Save settings
- Send test message
- Hidupkan `Auto send intro` hanya selepas test berjaya

## 9. Risk yang masih memang normal

- WhatsApp Business biasa tak boleh auto-send sebenar
- TikTok payload boleh berbeza ikut lead flow/account setup
- Meta webhook perlukan token yang sah untuk tarik detail lead penuh

## 10. Launch order paling selamat

1. Hidupkan `server mode`
2. Set `Public base URL`
3. Map `Salam Land` dulu
4. Test 1 lead Meta
5. Test 1 lead TikTok
6. Confirm record masuk betul
7. Baru sambung `Bumi Hayat`
8. Lepas itu `Barakah Emas`
