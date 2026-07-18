# CRM Salam Fortress Major Update - 12 May 2026

## Scope
- WhatsApp API is excluded for this release.
- Salam Land remains the live priority for Meta and TikTok lead operations.
- Bumi Hayat and Barakah Emas stay untouched for TikTok/lead-form rollout until owner asks to continue.

## Production Fixes
- Salam order input is locked to three product lanes: `Tanah Lot Semi D`, `Tanah Banglo`, and `Lot Kedai`.
- Salam order must include `No lot tanah`, `Project / daerah`, and `Harga lot` so booking board can identify the exact land unit.
- Duplicate guard blocks duplicate Salam order when the same phone and same lot already exist.
- Old `Quick booking dari Lot Status Board` text is cleaned from remarks so staff notes stay readable.
- Old placeholder values like `Tanah/daerah belum diisi` are hidden from UI and normalized where project can be inferred.
- Payment phase schedule remains the correct place for customer bayar fasa by fasa. Staff should edit the same order, not create new orders.

## TikTok Salam Readiness
- CRM endpoint: `https://salamland.my/api/webhooks/tiktok`
- Callback secret reference: `crm-salam-fortress-tiktok`
- Salam advertiser ID mapped in CRM config: `7627145984715374610`
- Salam instant form ID mapped in CRM config: `7636799561561800967`
- Important: CRM-side mapping is ready. TikTok platform-side delivery still needs TikTok lead webhook/custom API access from TikTok Ads before real TikTok leads can flow directly.

## Push Notification Flow
- Push notification is for team sales lead alerts only.
- Staff must choose the staff filter first, then click `Enable noti`.
- The device subscription is stored by company and staff, so a phone/laptop only receives push pings for leads auto-assigned to that staff.
- Browser permission still must be allowed by the user because iOS/Android/desktop browsers do not allow silent notification enable.

## Staff Workflow
1. Open `Leads`.
2. Filter by own staff name.
3. Enable notification on that phone/laptop.
4. Work new leads from the lead table.
5. Use status dropdown for `WS Sent`, `Reply`, `Tak Jawab`, `Site Visit`, `Booking`, `Closed`, or `Lost`.
6. For booking/payment, edit the existing order and update payment phase rows.

## Backup
- Runtime backups are written before cleanup/config scripts into `data/backups`.
- Code backup should be created before deployment and after deployment.
- For Google Sheet backup, run `scripts/export-gsheet-backup.mjs` only when the Google backup target is available.
