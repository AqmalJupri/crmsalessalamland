# TikTok Salam Land Launch Ready

Updated: 13 May 2026

Scope: Salam Land only. Bumi Hayat and Barakah remain paused by request.

## CRM Endpoints

Official/signed TikTok webhook:

```text
https://salamland.my/api/webhooks/tiktok
```

Secure connector fallback endpoint:

```text
https://salamland.my/api/webhooks/tiktok/connector
```

Connector auth:

```text
Authorization: Bearer <TikTok callback secret>
```

or:

```text
?token=<TikTok callback secret>
```

Do not paste the callback secret in screenshots, public docs, or ad creative.

## Salam Land TikTok Mapping

- Advertiser ID: `7627145984715374610`
- Instant form ID: `7636799561561800967`
- CRM source label: `TikTok Ads`
- Company: `Salam Land Development`
- Default status: `New Lead`
- Staff assignment: campaign name staff keyword first, otherwise CRM rotation.
- Staff keywords: `nureen`, `nurin`, `wafi`, `tasha`, `natasha`, `sabrina`, `ain`

## Recommended TikTok Campaign Setup

1. Objective: `Lead generation`.
2. Optimization location: `Instant Form`.
3. Destination: attach existing form `SLD - Tanah Lot Terengganu - CRM Lead Form`.
4. Naming format:

```text
TT | Salam | <Daerah> | <Staff> | <Date>
```

Examples:

```text
TT | Salam | Wakaf Tapai Marang | Tasha | 2026-05-14
TT | Salam | Sungai Ikan Setiu | Sabrina | 2026-05-14
TT | Salam | Bukit Diman Ajil | Ain | 2026-05-14
```

## Lead Form Fields

Keep the form short:

- Full name
- Phone number
- Tujuan cari tanah
- Kawasan minat dalam Terengganu
- Bajet anggaran

Do not show:

- CRM website link
- Staff phone number
- Internal team notes
- Too many lot/project options

## Areas To Use

- Wakaf Tapai, Marang
- Sungai Ikan, Setiu
- Gemuruh, Kuala Nerus
- Bukit Diman, Ajil

## CRM Payload Readiness

The CRM now accepts TikTok lead payloads in these common shapes:

- Single lead object
- `data` object
- `lead` object
- `leads` array
- `items` array
- `field_data`, `form_data`, `answers`, or `fields`

The CRM will normalize:

- Name
- Phone
- Campaign
- Ad/adgroup IDs if provided
- Area/project if provided
- Staff from campaign naming
- Spend if provided by connector/API payload

## External TikTok Requirement

The CRM is ready, but real auto-sync requires one of these TikTok-side options:

- TikTok Custom API with Webhooks access, pointed to the CRM endpoint.
- A TikTok-approved CRM/direct integration that can send webhook payloads to the secure connector endpoint.
- Manual CSV download/import as emergency fallback only.

Google Sheets, n8n, WhatsApp API, Zapier, and LeadsBridge are intentionally not used in this scope unless explicitly approved later.
