# TikTok LeadsBridge Backfill

Tujuan dokumen ini ialah import semula TikTok leads lama daripada LeadsBridge ke CRM tanpa duplicate dan tanpa ganggu status lead yang team sales sudah update.

## Apa Yang Sistem Buat

- Baca payload TikTok/LeadsBridge dalam format JSON, nested JSON, array, atau CSV.
- Padankan lead kepada company integration TikTok berdasarkan `companyId`, advertiser ID, atau form ID.
- Cipta ID stabil untuk lead walaupun LeadsBridge tidak beri `lead_id`.
- Skip lead yang sama berdasarkan external ID atau fingerprint `phone + date + campaign`.
- Tidak hantar WhatsApp intro atau push notification untuk backfill data lama.
- Tidak overwrite status lead/order yang sudah wujud dalam CRM.

## Endpoint Admin

```http
POST /api/integrations/tiktok-leadsbridge-backfill
```

Endpoint ini perlukan login admin CRM.

## Endpoint Auto Sync LeadsBridge

Untuk lead baru, LeadsBridge perlu hantar webhook terus ke CRM:

```http
POST https://crm.salamland.my/api/webhooks/tiktok?token=YOUR_TIKTOK_CALLBACK_TOKEN&companyId=salam-land
```

Nota:

- `companyId=salam-land` wajib untuk pastikan lead masuk workspace Salam Land, bukan company lain.
- `token` mesti sama dengan TikTok callback token dalam CRM Integrations.
- LeadsBridge boleh hantar payload sebagai JSON, form-encoded, nested object, array, atau field table.
- Sistem akan parse `Lead ID`, tarikh `DD/MM/YYYY HH:mm`, nama customer, phone, campaign/ad group/ad name, dan staff hint.
- Campaign/ad group seperti `Lead genth nureen`, `Lead Gent h wafi`, `Lead sabrina`, `Lead ain`, atau `Lead tasha` akan digunakan untuk auto assign staff.
- Lead baru tidak akan overwrite status lead lama yang team sales sudah update.

## Dry Run Dahulu

Dry run hanya semak data. Ia tidak simpan apa-apa ke database.

```json
{
  "companyId": "salam-land",
  "dryRun": true,
  "dateFrom": "2026-06-01",
  "dateTo": "2026-06-30",
  "csv": "Lead ID,Full Name,Phone Number,Created Time,Campaign Name\n123,Ali,60123456789,2026-06-24,Lead genth nureen"
}
```

Response penting:

- `captured`: jumlah lead baru yang akan masuk kalau import sebenar dibuat.
- `duplicate`: jumlah lead yang sudah ada dan akan diskip.
- `unmapped`: form/advertiser belum dipetakan ke company CRM.
- `invalid`: row/payload tidak sah.
- `skippedDate`: row luar range `dateFrom/dateTo`, contohnya sebelum `01/06/2026`.

## Import Sebenar

Hanya buat selepas dry run nampak betul.

```json
{
  "companyId": "salam-land",
  "dryRun": false,
  "dateFrom": "2026-06-01",
  "dateTo": "2026-06-30",
  "csv": "..."
}
```

## Rules Penting

- Jangan import CSV yang sama berkali-kali tanpa lihat `duplicate` count.
- Jangan import sebagai company lain.
- Untuk Salam Land gunakan `companyId: "salam-land"`.
- Backfill tidak akan reset lead lama kepada `New Lead`.
- Backfill tidak akan tukar status yang team sales sudah update.
- Duplicate detection guna external ID jika ada, kemudian fallback kepada `phone + tarikh + campaign/ad group`.
- Kalau LeadsBridge row lama masih tunjuk `Sync Now`, boleh sync semula selepas endpoint betul. CRM akan skip row yang sudah wujud.

## Rollback

Jika import sebenar tersalah, restore runtime/database daripada backup sebelum import. Backup local terakhir sebelum patch:

- `backups/runtime-before-tiktok-leadsbridge-20260703-110820.json`
- `backups/server-before-tiktok-leadsbridge-20260703-110820.js`

Untuk production, ambil backup server/database live sebelum deploy dan sebelum import sebenar.
