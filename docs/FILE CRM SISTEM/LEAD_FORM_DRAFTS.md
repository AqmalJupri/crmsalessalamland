# CRM Salam Fortress Lead Form Drafts

Last updated: 2026-05-13

Purpose: Draft ringkas untuk Meta Lead Form dan TikTok Instant Form supaya lead masuk CRM tanpa terlalu banyak soalan random.

Core rule:

- Jangan letak semua projek/produk sebagai pilihan panjang dalam form.
- Biarkan CRM simpan semua projek/produk.
- Form hanya tapis niat, lokasi/kategori, bajet/quantity, dan urgency.
- Staff sambung detail selepas lead masuk.
- Jangan letak website, nombor staff, atau CTA WhatsApp yang client nampak.
- Privacy policy link sahaja dikekalkan sebab platform ads wajibkan untuk lead form.

## 1. Field Standard Untuk Semua Form

Gunakan default platform fields:

- Full name
- Phone number

Privacy policy URL untuk semua form:

```text
https://salamland.my/privacy
```

Jangan tambah terlalu banyak personal question pada form pertama.

CRM akan auto-capture:

- Tarikh lead masuk
- Source
- Campaign
- Company
- Status awal
- Staff assignment
- Follow-up due

## 2. Salam Land Development

Meta ad account ID:

```text
398314092818758
```

Meta Page ID observed:

```text
330336670172572
```

Published Meta form name:

```text
SLD - Tanah Lot - CRM Lead Form
```

Published Meta form ID:

```text
3226859620830130
```

CRM capture status:

```text
Live verified. Meta Lead Ads Testing Tool delivered test lead to CRM through https://salamland.my/api/webhooks/meta.
```

TikTok CRM status:

```text
CRM-ready for Salam Land advertiser 7627145984715374610. Synthetic signed webhook test captured successfully through https://salamland.my/api/webhooks/tiktok.
```

TikTok instant form status:

```text
Submitted for review on 2026-05-07.
Form name: SLD - Tanah Lot Terengganu - CRM Lead Form
Form ID: 7636799561561800967
TikTok Lead Center status: confirm in TikTok Ads Manager before launch
CRM popup status: Not connected to CRM. Normal Lead Center UI shows Google Sheets direct connection and third-party connectors such as Zapier/LeadsBridge, not a direct custom webhook field.
CRM production mapping: advertiser 7627145984715374610 + form 7636799561561800967.
CRM webhook retest: captured synthetic signed lead tt-test-20260507-form-7636799561561800967 as TikTok Ads.
CRM connector fallback: https://salamland.my/api/webhooks/tiktok/connector accepts secure-token payloads if TikTok/approved CRM connector cannot send the official TikTok signature header.
```

Form intro:

```text
Cari tanah untuk bina rumah atau pelaburan? Isi maklumat ringkas, team Salam Land akan bantu shortlist lot yang sesuai ikut bajet dan kawasan.
```

Fields:

```text
Full name
Phone number
```

Custom questions:

1. Apa tujuan utama anda cari tanah?

```text
Bina rumah sendiri
Pelaburan
Untuk keluarga
Survey dulu
```

2. Kawasan tanah di Terengganu mana yang anda berminat?

```text
Wakaf Tapai, Marang
Sungai Ikan, Setiu
Gemuruh, Kuala Nerus
Bukit Diman, Ajil
```

3. Anggaran bajet anda?

```text
RM39k - RM60k
RM61k - RM100k
RM101k - RM180k
Nak semak ikut lot available
```

Optional high-intent question, guna hanya kalau lead banyak tapi kurang berkualiti:

```text
Status pembeli?
Bumi
Non-Bumi
Tidak pasti
```

Thank-you screen:

```text
Terima kasih. Team Salam Land akan hubungi anda untuk semak kawasan, bajet dan lot yang masih available.
```

CTA / ending action:

```text
Tiada public CTA. Lead masuk CRM, kemudian team sales ambil tindakan dalam sistem.
```

TikTok campaign naming wajib untuk auto assign staff:

```text
TT | Salam | Wakaf Tapai Marang | Tasha | 2026-05-14
TT | Salam | Sungai Ikan Setiu | Sabrina | 2026-05-14
TT | Salam | Bukit Diman Ajil | Ain | 2026-05-14
```

CRM mapping:

- Purpose -> details.buyerIntent
- Area -> details.locationPreference
- Budget -> details.budgetRange
- Buyer status -> details.buyerSegment
- Product default -> Tanah lot
- Status default -> New Lead
- Source default -> Meta Ads or TikTok Ads, depending on platform source
- Staff assignment -> auto rotation by Salam Land team sales
- Public website link -> not used
- Public staff phone number -> not used

## 3. Bumi Hayat Printing

Meta account/page ID:

```text
573344855853053
```

Recommended form name:

```text
Bumi Hayat - Jersey & Printing Lead Form
```

Form intro:

```text
Nak buat jersey, baju sukan atau uniform team? Isi maklumat ringkas, team Bumi Hayat akan bantu semak quotation ikut quantity dan kategori order.
```

Fields:

```text
Full name
Phone number
```

Custom questions:

1. Kategori order yang anda nak?

```text
Jersey / Futsal
Rumah sukan / Event
Windbreaker / Tracksuit
Corporate / Uniform
Belum pasti, nak tengok pilihan
```

2. Anggaran quantity?

```text
10 - 20 helai
21 - 50 helai
51 - 100 helai
100+ helai
```

3. Status design anda?

```text
Ada design sendiri
Perlu bantuan design
Nak mockup dulu
Belum pasti
```

Optional high-intent question:

```text
Bila nak siap?
Dalam 2 minggu
Dalam 1 bulan
Lebih 1 bulan
Belum pasti
```

Thank-you screen:

```text
Terima kasih. Team Bumi Hayat akan hubungi anda untuk semak kategori, quantity, design dan quotation.
```

CTA:

```text
WhatsApp Bumi Hayat
```

CRM mapping:

- Category -> product
- Quantity -> details.quantityRange
- Design status -> details.designNeed
- Deadline -> details.deadlineIntent
- Status default -> New Lead

## 4. Barakah Emas

Meta account/page ID:

```text
1275140334740450
```

Recommended form name:

```text
Barakah Emas - Gold Lead Form
```

Form intro:

```text
Nak beli, jual atau survey harga emas? Isi maklumat ringkas, team Barakah Emas akan bantu semak pilihan dan harga semasa.
```

Fields:

```text
Full name
Phone number
```

Custom questions:

1. Apa tujuan anda?

```text
Nak beli emas
Nak jual emas
Trade-in emas
Survey harga dulu
```

2. Jenis emas yang anda berminat?

```text
Emas 916
Emas 999
Emas baru
Emas terpakai
Tak pasti, nak staff bantu
```

3. Bajet atau anggaran gram?

```text
Bawah RM500 / bawah 1g
RM500 - RM1,500 / 1g - 5g
RM1,500 ke atas / 5g+
Nak semak harga semasa dulu
```

Optional high-intent question:

```text
Bila anda nak berurusan?
Hari ini
Minggu ini
Bulan ini
Survey dulu
```

Thank-you screen:

```text
Terima kasih. Team Barakah Emas akan hubungi anda untuk semak jenis emas, harga semasa dan pilihan yang sesuai.
```

CTA:

```text
WhatsApp Barakah Emas
```

CRM mapping:

- Purpose -> transactionType
- Gold type -> product
- Budget/gram -> details.budgetOrGramRange
- Urgency -> details.urgency
- Status default -> New Lead

## 5. Recommended Setup By Platform

Meta Lead Form:

- Use More Volume for testing awal.
- Switch to Higher Intent kalau lead banyak tapi tak berkualiti.
- Use the same question wording across campaigns for easier CRM mapping.
- If Meta requires an ending action, do not use website, call, or WhatsApp number CTA unless approved.
- Preferred fallback is a neutral View File asset with logo/thank-you only, so lead still moves through CRM.

TikTok Instant Form:

- Use simple 3 custom questions.
- Avoid long dropdown lists.
- Keep the final page clean with no website link, staff phone number, or WhatsApp CTA.

## 6. CRM Naming Convention

Use campaign/form names like this:

```text
SLD_Meta_TanahLot_LowBudget
SLD_TT_TanahLot_SiteVisit
BH_Meta_Jersey_Quantity
BE_Meta_Emas916_Survey
```

Reason:

- Easier to map company.
- Easier to detect source.
- Easier for reports and CPL review.

## 7. Do Not Put In First Lead Form

Avoid these on first form:

- IC upload
- Full address
- Too many project/lot choices
- Too many product SKUs
- Long free-text questions
- Sensitive financial questions that are too direct

Collect these after staff follow-up or when converting to order.
