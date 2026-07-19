# CRM Salam Fortress PRD Workflow

## Matlamat

CRM Salam Fortress ialah satu sistem operasi untuk tiga company, tetapi setiap company ada workspace, warna, produk, staff, lead, order dan report masing-masing. Front page tidak memaparkan data dalaman; pengguna mesti login sebelum boleh akses dashboard live.

## Role Login

- Admin: akses semua company, integrations, backup, reports dan settings.
- Management: akses semua company, performance, report dan operational monitoring.
- Staff company: login satu username company dan terus masuk workspace company sendiri sahaja.

## Front Page

- Layer 1: secure login page sahaja, tanpa senarai username/password di paparan depan.
- Layer 2: dashboard CRM selepas login, ikut akses role.
- Mobile/tablet/laptop/PC mesti responsive dan tidak tersepit.

## Navigation Folder

- Dashboard: KPI ringkas, company overview dan action utama.
- Leads: lead table, daily calendar drilldown, lot status Salam Land dan tick checklist staff.
- Payments: bayaran berfasa, deposit, collected, outstanding dan graph staff.
- Reports: staff performance, marketing spend, CPL dan PDF report.
- Follow-up: WhatsApp follow-up queue, blast reminder dan 14-day follow-up.
- Technical: Meta/TikTok webhook, sync mapping, public base URL dan system health.
- Settings: access, backup, reminders dan audit log.

## Lead Workflow

- Lead masuk automatik dari Meta Lead Ads dan TikTok Lead Ads apabila token/webhook aktif.
- Sistem simpan tarikh lead masuk ikut waktu Malaysia.
- Lead ada source, campaign, staff assignment, status, next follow-up dan action tick.
- Staff boleh tekan Open WS untuk buka WhatsApp customer terus dengan ayat mengikut nama staff.
- Staff boleh tick kerja harian seperti WS sent, reply, no answer, site visit, booking dan closed.

## Payment Workflow

- Order boleh simpan booking amount, deposit, bayaran berfasa, next payment date dan payment status.
- Payment board kira total order value, collected, outstanding dan due dalam 7 hari.
- Graph staff tunjuk collection progress setiap team sales.

## Salam Land Scope

- Produk tanah dan lot dipantau mengikut daerah/projek Terengganu.
- Lot board tunjuk available, lead hold, reserved, booking dan closed.
- Lead/order Salam Land perlu fokus kepada tanah, buyer segment Bumi/Non-Bumi, lot, price, booking dan closed value.

## Integrations

- Meta: Salam Land aktif dahulu untuk lead auto-sync dan polling backup.
- TikTok: perlu sambung advertiser/form token untuk Salam Land dahulu sebelum Bumi Hayat/Barakah.
- WhatsApp API: boleh dibina dalam CRM, tetapi memerlukan WhatsApp Cloud API/Business API number, token dan caj conversation Meta.

## Backup

- Runtime/database CRM perlu backup automatik di server.
- Code perlu backup manual sebelum release besar.
- GSheet lama tidak menjadi sistem utama; jika perlu, hanya import/export sementara.
