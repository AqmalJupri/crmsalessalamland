# WhatsApp Cloud API Setup

Dokumen ini untuk setup Official WhatsApp Cloud API dalam CRM Salam Fortress tanpa guna QR, Baileys, whatsapp-web.js, atau mass blast.

## Apa Yang CRM Sudah Support

- Admin settings untuk WABA ID, Phone Number ID, template, language code, verify token, dan test recipient.
- Access token dibaca dari environment variable backend sahaja.
- Auto hantar approved template bila lead baru berjaya masuk CRM.
- Lead tetap disimpan walaupun WhatsApp API gagal.
- Outbound message log disimpan dalam `data/runtime.json`.
- Inbound reply webhook disimpan dan dipadankan dengan lead melalui nombor telefon.
- Status message `sent`, `delivered`, `read`, dan `failed` disimpan bila Meta hantar webhook status.
- Opt-out reply seperti `STOP`, `TAK NAK`, `TIDAK BERMINAT`, `JANGAN MESEJ`, dan `CANCEL` akan ditanda dalam lead.

## ENV Production

Jangan letak token sebenar dalam frontend atau commit ke Git. Isi variable ini di server/VPS sahaja.

```bash
WHATSAPP_GRAPH_API_VERSION=v22.0
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_WABA_ID=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
WHATSAPP_DEFAULT_TEMPLATE_NAME=
WHATSAPP_DEFAULT_LANGUAGE_CODE=ms
WHATSAPP_ALLOWED_STAFF=Nureen
# Optional one-time registration helper. Jangan commit nilai sebenar.
WHATSAPP_REGISTER_PIN=
```

## Setup Di Meta

1. Buka Meta Business Manager.
2. Pergi ke WhatsApp Manager.
3. Pastikan WhatsApp Business Account sudah aktif.
4. Add atau pilih phone number rasmi.
5. Salin `WABA ID`.
6. Salin `Phone Number ID`.
7. Generate access token yang sesuai untuk server.
8. Buat WhatsApp message template untuk intro lead.
9. Tunggu template approved.

## Setup Webhook

Callback URL:

```text
https://crm.salamland.my/api/webhooks/whatsapp
```

Verify token:

```text
Sama dengan WHATSAPP_WEBHOOK_VERIFY_TOKEN di server ENV.
```

Subscribe field:

```text
messages
```

## Setup Dalam CRM

1. Login admin.
2. Pergi ke `Integrations`.
3. Buka sub menu `WhatsApp API`.
4. Tekan `Open WhatsApp settings`.
5. Isi WABA ID, Phone Number ID, template name, language code, dan test recipient.
6. Pastikan `Access token ENV key` kekal `WHATSAPP_ACCESS_TOKEN` kecuali server guna nama ENV lain.
7. Untuk pilot pertama, kekalkan `WHATSAPP_ALLOWED_STAFF=Nureen` supaya auto intro hanya trigger untuk lead yang assigned kepada Nureen.
8. Set `Auto send intro` kepada `On` hanya selepas test berjaya.
9. Tekan `Save WhatsApp settings`.
10. Tekan `Send test message`.

## Register Nombor Ke Cloud API

Jika Meta paparkan `The phone number is not registered with Cloud API`, nombor belum boleh hantar mesej melalui API walaupun display name sudah approved.

Pilihan A, melalui CRM:

1. Pastikan `WHATSAPP_ACCESS_TOKEN` sudah wujud di ENV server.
2. Login CRM sebagai admin.
3. Pergi ke `Integrations > WhatsApp API`.
4. Tekan `Open WhatsApp settings`.
5. Isi `Phone Number ID`.
6. Isi `Cloud API register PIN` enam digit hanya jika Meta sudah benarkan two-step PIN untuk nombor itu. Jika Meta masih paparkan `Account does not exist in Cloud API`, kosongkan PIN dan cuba register dahulu.
7. Tekan `Register Cloud API number`.

Pilihan B, melalui server:

```bash
WHATSAPP_ACCESS_TOKEN="token-dari-meta" \
WHATSAPP_PHONE_NUMBER_ID="1123872404150614" \
node scripts/register-whatsapp-cloud-api.js
```

Selepas berjaya, refresh WhatsApp Manager dan status nombor patut bertukar kepada Cloud API connected. Jangan ON auto intro sebelum test message berjaya.

## Current Pilot Status

- Pilot staff: Nureen sahaja.
- Pilot phone: `01121484813` / `601121484813`.
- Phone number Meta mesti berstatus `Connected` sebelum dijadikan live sender.
- Jika status masih `Pending` atau `In review`, jangan ON auto intro untuk production.

## Test Wajib

- Send test template ke nombor internal.
- Create satu lead test dengan nombor telefon yang valid.
- Pastikan lead tetap masuk CRM.
- Pastikan outbound WhatsApp message masuk log.
- Reply daripada WhatsApp customer.
- Pastikan reply masuk ke WhatsApp History lead.
- Pastikan status delivered/read/failed dikemaskini.
- Test nombor invalid dan pastikan CRM tidak crash.
- Test opt-out reply `STOP` atau `TAK NAK`.

## Rollback

Kalau WhatsApp API bermasalah:

1. Login CRM sebagai admin.
2. Pergi ke `Integrations > WhatsApp API`.
3. Buka settings.
4. Tukar `Auto send intro` kepada `Off`.
5. Save.

Jika perlu rollback code:

```bash
git status
git checkout <branch-stable-sebelum-change>
```

Database/data runtime tidak perlu restore kecuali data rosak. Jika perlu, restore daripada backup `data/backups` atau snapshot server terkini.

## Nota Risiko

- WhatsApp template mesti approved sebelum auto-send boleh berjaya.
- Token tamat tempoh atau permission salah akan menyebabkan message failed, tetapi lead tetap masuk CRM.
- Webhook wajib HTTPS.
- Jangan aktifkan mass blast sebelum consent, rate limit, dan opt-out policy lengkap.
