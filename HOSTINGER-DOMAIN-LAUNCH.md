# Hostinger Domain Launch Guide

Panduan ini khas untuk sambung `CRM Salam Fortress` bila awak sudah ada atau baru nak beli:

- `VPS Hostinger`
- `domain`
- atau sekurang-kurangnya `subdomain` untuk CRM

## 1. Struktur domain yang saya cadangkan

Paling kemas:

- website utama bisnes: `yourdomain.com`
- CRM: `crm.yourdomain.com`

Contoh:

- `salamfortress.com`
- `crm.salamfortress.com`

Kalau belum ada domain utama, beli satu domain yang pendek dan senang diingati. Jangan terus guna nama terlalu panjang.

## 2. Apa yang perlu dibeli dulu

Minimum:

1. `1 VPS Hostinger`
2. `1 domain`

Kalau domain dibeli di tempat lain pun tak apa. Yang penting awak boleh edit DNS.

## 3. Bila domain dah ada

Dalam panel DNS, buat `A record`:

- `Type`: `A`
- `Name`: `crm`
- `Points to`: `IP VPS awak`
- `TTL`: `Auto` atau `300`

Hasilnya:

```text
crm.yourdomain.com -> IP VPS
```

## 4. Check DNS hidup atau belum

Lepas simpan DNS, semak:

```bash
dig crm.yourdomain.com +short
```

Kalau keluar IP VPS yang betul, DNS sudah hidup.

## 5. Upload CRM Salam Fortress ke server

Cadangan path:

```bash
/var/www/crm-salam-fortress
```

## 6. Install komponen server

Masuk VPS dan install:

```bash
sudo apt update
sudo apt install -y nginx
```

Install Node.js LTS dan PM2 ikut kaedah pilihan awak. Lepas itu:

```bash
cd /var/www/crm-salam-fortress
pm2 start ecosystem.config.cjs
pm2 save
```

## 7. Sambung Nginx ke app

Guna contoh fail ini:

- `nginx.crm-salam-fortress.conf.example`

Point reverse proxy ke:

```text
127.0.0.1:8876
```

## 8. Hidupkan HTTPS

Lepas Nginx hidup:

```bash
sudo certbot --nginx -d crm.yourdomain.com
```

Lepas berjaya, CRM sepatutnya boleh dibuka di:

```text
https://crm.yourdomain.com
```

## 9. Update setting dalam CRM

Masuk menu `Integrations` dan isi:

```text
Public base URL = https://crm.yourdomain.com
```

Ini penting supaya webhook Meta dan TikTok guna URL betul.

## 10. URL penting selepas launch

Health:

```text
https://crm.yourdomain.com/api/health
```

Meta webhook:

```text
https://crm.yourdomain.com/api/webhooks/meta
```

TikTok webhook:

```text
https://crm.yourdomain.com/api/webhooks/tiktok
```

Gold rate API:

```text
https://crm.yourdomain.com/api/rates/gold
```

## 11. Urutan launch yang paling selamat

1. beli VPS
2. beli domain
3. buat `crm` subdomain
4. point DNS ke VPS
5. upload project
6. hidupkan `PM2`
7. setup `Nginx`
8. setup `SSL`
9. buka CRM
10. isi `Public base URL`
11. test `health endpoint`
12. baru sambung Meta Ads
13. lepas itu TikTok Ads

## 12. Bila dah ready sambung ads

Data yang awak kena sediakan:

- `Meta Page ID`
- `Meta Form ID`
- `Meta Page Access Token`
- `TikTok Advertiser ID`
- `TikTok Form ID`
- `TikTok callback / signing secret`

## 13. Apa yang saya boleh bantu next

Bila awak dah ada:

- IP VPS
- domain

saya boleh bantu sambung langkah:

1. semak DNS
2. semak config Nginx
3. set `Public base URL`
4. semak URL webhook
5. map `Salam Land`, `Bumi Hayat`, dan `Barakah Emas`
