# CRM Salam Fortress Production Package

Kalau belum ada VPS atau domain, fail dalam folder ini sudah cukup untuk sediakan layer production awal.

Rujuk juga:

- `DEPLOYMENT-CHECKLIST.md`
- `HOSTINGER-DOMAIN-LAUNCH.md`

## Clean Package Contract

Production package mesti dibina menggunakan strict allowlist, bukan dengan menyalin semua fail yang tidak dikecualikan. Untuk hardening-only release ini, allowlist ialah:

- `server.js` sebagai satu-satunya runtime replacement
- `ecosystem.config.cjs` sebagai target-checked configuration artifact
- `.env.production.example` sebagai dokumentasi sahaja
- `DEPLOYMENT-CHECKLIST.md` dan `PRODUCTION-PACKAGE.md`
- `scripts/production-package-audit.mjs`
- `scripts/smoke-lead-ingestion-guards.mjs`
- `scripts/smoke-stabilize-sales-production.mjs`

`app.js`, `index.html`, `styles.css`, `privacy.html`, `sw.js` dan `assets/**` tidak termasuk dalam hardening-only package kerana ia sama dengan production baseline atau tidak diperlukan oleh security patch ini. Jalankan audit tanpa deployment:

```bash
node scripts/production-package-audit.mjs --dry-run
```

Exclusion list wajib:

- `backups/`
- `deploy/`
- `exports/`
- `handoff/`
- `node_modules/`
- `.git/`
- `logs/`
- `reports/`
- `data/runtime.json`
- `data/auth.json`
- `data/backups/`
- `data/uploads/`
- real `.env files` seperti `.env`, `.env.production`, `.env.local`, atau varian lain yang bukan fail `.example`
- AppleDouble `._*` files
- operational register/cleanup/repair/configure/backfill scripts yang tidak berada dalam allowlist

`.env.production.example` boleh dimasukkan kerana ia hanya contract placeholder tanpa nilai secret sebenar. Nilai production mesti disuntik melalui environment server/PM2, bukan dibundle dalam package.

Gate sebelum package dianggap release-ready:

- `NODE_ENV=production`
- `CRM_REQUIRE_WEBHOOK_SIGNATURES=true`
- `META_APP_SECRET` telah diisi pada environment production
- `META_ALLOW_UNSIGNED_WEBHOOKS=false`
- `TIKTOK_ALLOW_UNSIGNED_WEBHOOKS=false`
- TikTok callback token dalam CRM integration settings telah ditukar daripada `crm-salam-fortress-tiktok` kepada token unik deployment

Dry-run mengesahkan strict allowlist, exclusion contract, hardening-only route scope dan target PM2 `crm-salamland-my` pada `/var/www/crm.salamland.my`, `127.0.0.1:8877`. Ia tidak membaca atau mengesahkan kandungan production runtime/auth, live uploads, secret sebenar, backup sebenar atau rollback snapshot.

## Fail yang dah siap

- `ecosystem.config.cjs`
  - config artifact khusus `crm-salamland-my`; penggunaannya masih memerlukan approval deployment/restart berasingan
- `.env.production.example`
  - template environment variable production
- `nginx.crm-salam-fortress.conf.example`
  - contoh reverse proxy Nginx ke server Node tempatan
- `docs/WHATSAPP-CLOUD-API-SETUP.md`
  - panduan setup Official WhatsApp Cloud API, webhook, ENV, test dan rollback

## Spec VPS minimum yang saya cadangkan

- CPU: `1 vCPU`
- RAM: `2 GB`
- Storage: `25 GB SSD`
- OS: `Ubuntu 24.04 LTS`

Ini sudah cukup untuk:

- 3 workspace company
- lead dashboard
- webhook Meta / TikTok
- PDF report
- gold rate sync Barakah Emas

Kalau nanti team makin besar atau traffic ads makin tinggi:

- upgrade ke `2 vCPU`
- RAM `4 GB`

## Bila awak dah beli VPS

1. Install `Node.js LTS`
2. Install `PM2`
3. Install `Nginx`
4. Target production Salam Land CRM yang telah diverifikasi ialah:

```bash
/var/www/crm.salamland.my
```

5. Jangan gunakan `ecosystem.config.cjs` untuk start/reload tanpa approval khusus dan dry-run deployment yang menyemak process `crm-salamland-my`, cwd serta port `8877`.
6. Sebarang PM2/nginx action berada di luar clean package contract ini.

## Lepas domain siap

URL webhook yang awak akan guna:

- Meta:
```text
https://crm.yourdomain.com/api/webhooks/meta
```

- TikTok:
```text
https://crm.yourdomain.com/api/webhooks/tiktok
```

- WhatsApp Cloud API:
```text
https://crm.yourdomain.com/api/webhooks/whatsapp
```

## Saranan saya sekarang

Kalau awak belum ada VPS/domain lagi, next step paling bagus ialah:

1. beli `1 VPS Ubuntu`
2. beli atau guna `1 subdomain`
3. lepas itu saya boleh bantu awak map sampai live
