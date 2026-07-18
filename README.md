# CRM Salam Fortress

CRM Salam Fortress ialah satu command center untuk tiga company dalam satu website besar:

- Salam Land Development
- Bumi Hayat Printing
- Barakah Emas

## Reka bentuk

- Satu shell sistem premium.
- Setiap company ada warna, hero, logo dan gaya visual sendiri.
- Layout dibuat ringan dengan HTML, CSS dan vanilla JavaScript supaya cepat dibuka dan tidak bergantung pada subscription atau framework berat.

## Logic kerja

- Lead form disederhanakan supaya staff hanya isi maklumat penting.
- Order form diasingkan daripada lead supaya data jualan lebih kemas.
- Source, campaign, tarikh, CPL, spend dan queue follow-up ditunjukkan terus dalam workspace.
- Monthly blast, 14-day follow-up dan night reply script kekal tersedia untuk WhatsApp Business tanpa API.
- Publish layer sekarang ada `server.js` untuk mode production ringan: static app + API + webhook endpoint dalam satu proses Node.
- Integration cockpit membenarkan mapping per company untuk `Meta Ads` dan `TikTok Ads`, termasuk page/form IDs, default staff, status awal dan webhook preview.
- Workspace `Barakah Emas` sekarang ada `Gold Rate Center` yang auto kira harga rujukan `Emas 999` dan `Emas 916` per gram menggunakan spot gold + USD/MYR FX harian.

## Nota penting

- App ini masih boleh jalan local-first dalam `localStorage`, tetapi bila run `node server.js` ia akan auto naik ke `server mode`.
- WhatsApp Business biasa tidak membenarkan auto-send sebenar tanpa API rasmi.
- Meta live lead capture perlukan Page/Form mapping + access token.
- TikTok live capture perlukan callback URL HTTPS dan mapping advertiser/form yang betul.
- Gold rate center ialah `harga rujukan spot-based`, bukan final harga retail kedai. Upah, spread dan buyback rule masih boleh ditetapkan berasingan.

## Cara run publish mode

- Preview biasa: buka `index.html`
- Publish / webhook mode:
```bash
node server.js
```
- Lepas itu buka `http://127.0.0.1:8765/`
- Runtime production akan disimpan dalam `data/runtime.json` bila server pertama kali dijalankan.
- Deployment playbook penuh ada dalam `DEPLOYMENT-CHECKLIST.md`
- Production package cepat untuk PM2/Nginx/env ada dalam `PRODUCTION-PACKAGE.md`
