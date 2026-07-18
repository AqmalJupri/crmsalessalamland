# CRM Salam Fortress Backup and Recovery

Last updated: 2026-05-05

## Backup Contents

Each backup package should contain:

- `code/`: full source code archive.
- `production-data/`: latest runtime and auth JSON from server.
- `gsheet-export/`: CSV files ready to import into Google Sheets.
- `manifest.json`: backup timestamp and file summary.

## Important Files

- `runtime.json`: main CRM database for records, campaigns, integrations, gold rates, and activity.
- `auth.json`: user access database with password hashes.
- `server.js`: backend and webhook server.
- `app.js`: frontend logic.
- `index.html`: app layout.
- `styles.css`: app styling.

## Recovery Steps

1. Upload code archive to `/var/www/crm-salam-fortress`.
2. Restore `data/runtime.json`.
3. Restore `data/auth.json`.
4. Restart PM2:

```bash
pm2 restart crm-salam-fortress
```

5. Check health endpoint:

```text
https://salamland.my/api/health
```

## Google Sheets Restore

CSV files are for reporting and audit import, not direct system restore.

Recommended sheet tabs:

- Records
- Campaigns
- Users
- Integrations Summary
- Gold Rates

