# Official WhatsApp Cloud API Setup

This CRM uses the official Meta WhatsApp Cloud API only. It does not use Baileys, whatsapp-web.js, QR login, or any unofficial WhatsApp Web automation.

## Current Project Audit

- Frontend: vanilla HTML, CSS and JavaScript in `index.html`, `styles.css`, `app.js`.
- Backend: Node.js HTTP server in `server.js`.
- Database: JSON runtime files in `data/runtime.json` and `data/auth.json`.
- Core live modules: records/leads/orders, campaigns, integrations, lot status, payment schedules, reports, authentication, Meta webhook, TikTok webhook, push notifications.
- Sensitive logic not changed by the WhatsApp UI work: login/session, user role access, Meta webhook verification, TikTok webhook verification, lead assignment rules, payment calculation, report generation and production database schema.

## Backup Before This Feature

Local pre-feature backups were created before changes:

- Source backup: `backups/pre-whatsapp-cloud-api-20260525-084337/source-code.tgz`
- Database backup: `backups/pre-whatsapp-cloud-api-20260525-084337/database-data.tgz`
- Feature branch: `feature/official-whatsapp-cloud-api`

## Runtime Data Added

The JSON runtime now supports a WhatsApp module shaped like these tables:

- `whatsapp.settings`
- `whatsapp.messages`
- `whatsapp.optOuts`
- `whatsapp.inboundEvents`

No production data should be deleted or migrated destructively. Existing leads/orders remain in `records`.

## Environment Variables

Set these on the production server. Do not put real values in frontend files.

```env
WHATSAPP_GRAPH_API_VERSION=v22.0
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_WABA_ID=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
WHATSAPP_DEFAULT_TEMPLATE_NAME=
WHATSAPP_DEFAULT_LANGUAGE_CODE=ms
```

`WHATSAPP_ACCESS_TOKEN` must be a backend environment variable. The admin UI only stores the env key name, not the token value.

## Meta WhatsApp Setup

1. Open Meta Business Manager.
2. Go to WhatsApp Manager.
3. Create or select the WABA for Salam Land.
4. Add or verify the official WhatsApp phone number.
5. Copy the WABA ID and Phone Number ID.
6. Create a strong webhook verify token and put the same value in `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
7. Create an approved template message in Malay, for example an intro/thank-you template.
8. Put the approved template name in `WHATSAPP_DEFAULT_TEMPLATE_NAME`.
9. Add webhook URL: `https://salamland.my/api/webhooks/whatsapp`
10. Subscribe webhook fields for messages.

## CRM Admin Setup

1. Login as admin or management.
2. Open `Integrations`.
3. Open `WhatsApp settings`.
4. Fill WABA ID, Phone Number ID, template name, language code and test number.
5. Confirm access token env key is `WHATSAPP_ACCESS_TOKEN`.
6. Save settings.
7. Click `Send test message`.
8. Switch `Auto send intro` to `On` only after the test message succeeds.

## Flow Implemented

1. New lead is created from CRM form, Meta webhook or TikTok webhook.
2. CRM formats the customer phone number to Malaysia international format.
3. If WhatsApp is active and the lead belongs to Salam Land, the backend sends the approved template.
4. Outbound request is logged in `whatsapp.messages`.
5. If Meta returns sent/delivered/read/failed status, webhook updates the message status.
6. If customer replies, webhook logs inbound message and matches by phone number.
7. If customer replies opt-out keywords, CRM marks opt-out and blocks future automatic follow-up to that number.

## Opt-Out Keywords

- `STOP`
- `TAK NAK`
- `TIDAK BERMINAT`
- `JANGAN MESEJ`
- `CANCEL`

## Testing Checklist

- Login still works.
- Dashboard loads.
- Existing leads appear.
- Lead filters still work.
- WhatsApp button still opens manual WhatsApp.
- Add lead still works even if WhatsApp token is missing.
- Send test template message to internal number.
- New lead triggers outbound WhatsApp only when WhatsApp is active.
- Outbound message appears in lead profile WhatsApp History.
- Inbound customer reply appears in lead profile WhatsApp History.
- Sent/delivered/read/failed status updates correctly.
- Invalid phone number logs failed message but CRM does not crash.
- Missing token logs failed message but lead still saves.
- Opt-out reply creates opt-out badge and blocks future auto messages.
- No access token appears in frontend source or browser state.

## Deployment Checklist

- Backup production source code.
- Backup production `data/` folder.
- Confirm production env variables.
- Confirm HTTPS webhook URL.
- Confirm webhook verify token matches Meta.
- Confirm Phone Number ID and WABA ID.
- Confirm approved WhatsApp template.
- Deploy code.
- Restart Node/PM2 process.
- Test send internal message.
- Test one real lead form.
- Test inbound reply.
- Monitor logs and WhatsApp History for 24 hours.

## Rollback Plan

Code rollback:

```bash
git switch ui-cleanup-dashboard-v1
pm2 restart crm-salam-fortress
```

Database rollback:

1. Stop the Node process.
2. Restore the latest known-good `data/runtime.json` from backup.
3. Start the Node process.
4. Confirm `/api/health` returns OK.

Disable WhatsApp without code rollback:

1. Login as admin.
2. Open Integrations > WhatsApp settings.
3. Set `Auto send intro` to `Off`.
4. Save settings.

## Known Risks

- Template must be approved by Meta before production sending works.
- Webhook requires HTTPS.
- Meta may rate-limit or reject sends if phone/template/account quality has issues.
- Customer replies only arrive after webhook is correctly subscribed in Meta.
- This feature is not a blast system and should not be used for spam or bulk messaging.
