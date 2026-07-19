# CRM Salam Fortress Ads Integration Launch

Last updated: 2026-05-13
Production URL: https://salamland.my

## 1. Live Webhook URLs

Meta Lead Ads callback:

```text
https://salamland.my/api/webhooks/meta
```

Meta verify token:

```text
crm-salam-fortress-meta
```

TikTok Lead callback:

```text
https://salamland.my/api/webhooks/tiktok
```

TikTok secure connector fallback:

```text
https://salamland.my/api/webhooks/tiktok/connector
```

TikTok callback secret:

```text
crm-salam-fortress-tiktok
```

## 2. Account Scope

Meta ad accounts to connect:

- Salam Land Development / FN 1: `398314092818758`
- Bumi Hayat Printing: `573344855853053`
- Barakah Emas: `1275140334740450`

Meta Page IDs observed:

- Salam Land Development Sdn Bhd Page: `330336670172572`
- Bumi Hayat Printing Page: pending
- Barakah Emas Page: pending

TikTok accounts to connect:

- Salam Land Development only

## 3. Required Meta Details

For each Meta company account, collect:

- Page ID
- Lead Form ID or multiple Form IDs
- Page/User access token with lead retrieval permission
- Optional campaign ID for default mapping
- Optional spend access token if different from lead token

Recommended mapping:

| Company | Meta enabled | Required mapping |
| --- | --- | --- |
| Salam Land Development | Yes | Page ID + Form ID(s) + access token |
| Bumi Hayat Printing | Yes | Page ID + Form ID(s) + access token |
| Barakah Emas | Yes | Page ID + Form ID(s) + access token |

## 4. Required TikTok Details

For Salam Land TikTok account, collect:

- Advertiser ID
- Instant Form ID or multiple Form IDs
- TikTok access token, if API access is available
- Optional campaign ID for default mapping

Recommended mapping:

| Company | TikTok enabled | Required mapping |
| --- | --- | --- |
| Salam Land Development | Yes | Advertiser ID + Form ID(s) + access token |
| Bumi Hayat Printing | No | Leave disabled until account exists |
| Barakah Emas | No | Leave disabled until account exists |

## 5. CRM Configuration Flow

1. Login as admin at https://salamland.my.
2. Open Integrations.
3. Select company.
4. Enter public base URL:

```text
https://salamland.my
```

5. For Meta, turn on Meta Lead Ads only after Page ID or Form ID is filled.
6. Paste Meta access token.
7. Enable Meta spend sync only if token can read ad insights.
8. For TikTok Salam, turn on TikTok only after Advertiser ID or Form ID is filled.
9. Paste TikTok access token if available.
10. Save integration.
11. Send one test lead per company.
12. Confirm lead appears in Records with correct company, source, campaign, and assigned staff.

## 6. Safety Rules

- Do not enable a connection with blank Page ID, Form ID, or Advertiser ID.
- Do not reuse Salam token for Bumi or Barakah unless the same token truly has access to that Page/Form.
- Do not put tokens into public documents or screenshots.
- If a test lead comes in as unmapped, check Page ID/Form ID first.
- If a lead comes in but customer details are blank, check Meta/TikTok form field names.

## 7. Current Production Status

- Domain is live.
- HTTPS is live.
- CRM login is live.
- Meta webhook verification is live.
- TikTok webhook endpoint is live.
- TikTok secure connector fallback endpoint is live for approved CRM/custom API payloads that cannot send the official TikTok signature header.
- Public base URL is already set to https://salamland.my.
- Salam Land Meta lead form has been created/published: `SLD - Tanah Lot - CRM Lead Form`.
- Salam Land ad account is `398314092818758`.
- Salam Land Page ID observed in Ads Manager is `330336670172572`.
- Salam Land Meta form ID is `3226859620830130`.
- Meta app `SalamLeadsTracker` is connected to the Page leadgen webhook.
- Production CRM mapping is saved with Page token and lead retrieval enabled.
- Meta Lead Ads Testing Tool returned Success for app `SalamLeadsTracker`.
- CRM webhook replay after backend patch captured test lead `905729642496294` into Salam Land as `Meta Ads`, assigned to `Nurin`, status `New Lead`.
- Salam Land TikTok advertiser ID is mapped in CRM: `7627145984715374610`.
- Salam Land TikTok instant form has been completed/submitted for review: `SLD - Tanah Lot Terengganu - CRM Lead Form`.
- Salam Land TikTok instant form ID is `7636799561561800967`.
- TikTok Lead Center status for the new form is `Pending review` as of 2026-05-07 14:30.
- Production CRM TikTok mapping is narrowed to advertiser `7627145984715374610` and form `7636799561561800967`.
- TikTok Lead Center `Connect CRM` popup currently exposes Google Sheets direct connection and third-party options such as Zapier/LeadsBridge; no direct custom webhook URL field is available in the normal UI.
- TikTok CRM webhook test captured lead `tt-test-20260507-001` into Salam Land as `TikTok Ads`, assigned to `Nurin`, status `New Lead`.
- TikTok CRM webhook retest after form-specific mapping captured lead `tt-test-20260507-form-7636799561561800967` into Salam Land as `TikTok Ads`, assigned by rotation, status `New Lead`.
- TikTok backend now accepts single-lead and multi-lead payload shapes and can normalize `field_data`, `form_data`, `answers`, and `fields`.
- TikTok platform-side live lead delivery still needs TikTok Marketing API/custom API access or an approved connector before real TikTok leads flow automatically into the CRM without Google Sheets/Zapier.
- Bumi Hayat and Barakah Emas lead forms are paused until requested.
- Ads Manager may still show Google Sheets under automated delivery, but direct CRM capture is now handled by Meta Developer Webhooks.

## 8. Next Meta Build Steps

1. Build Salam Land campaigns/ad sets in Meta using the published lead form.
2. Keep campaign/ad naming clean so CRM attribution is easy to read.
3. Run one low-budget live test ad and confirm the first real lead lands in CRM.
4. If spend/CPL does not auto-fill, upgrade/token-check `ads_read` permission for insights.
5. For TikTok Salam, wait for form review approval, then attach the approved form to the TikTok campaign/ad group.
6. For TikTok Salam, request or configure TikTok Marketing API/custom API lead delivery to `https://salamland.my/api/webhooks/tiktok` using callback secret `crm-salam-fortress-tiktok`.
7. If TikTok/approved CRM connector cannot send TikTok signature headers, use the secure connector fallback endpoint with bearer token auth.
8. Keep Bumi Hayat and Barakah Emas paused until requested.
