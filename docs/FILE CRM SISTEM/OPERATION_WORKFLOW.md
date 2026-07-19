# CRM Salam Fortress Operation Workflow

Last updated: 2026-05-05

## 1. Login Flow

1. Open https://salamland.my.
2. Front page shows secure CRM access only.
3. Click Sign in.
4. Enter username and password.
5. System opens the correct workspace based on role.
6. Staff accounts go directly to their company workspace.
7. Admin and management can view all companies.

## 2. Daily Dashboard Check

1. Check total leads for today.
2. Check follow-up due today.
3. Check open queue.
4. Check orders and closed sales.
5. Check marketing spend and CPL.
6. Check staff performance.
7. Review records that need action before end of day.

## 3. Staff Lead Workflow

1. Open company workspace.
2. Go to Records or Pipeline.
3. Review assigned leads.
4. Contact customer through WhatsApp/call.
5. Update lead status.
6. Add short remark.
7. Add next follow-up date if customer is not closed.
8. Convert lead to order when customer is serious.

Minimum staff input:

- Status
- Staff/team sales
- Customer interest/product
- Remark
- Next follow-up date
- Order details if customer converts

System should auto-handle:

- Lead date
- Source
- Campaign
- Company
- Basic lead count
- Campaign CPL summary when spend exists

## 4. Salam Land Site Workflow

1. Staff opens Salam Land workspace.
2. Open Lot Status Board.
3. Search by lot number, project, customer, status, or staff.
4. Confirm whether lot is available, reserved, booking, closed, or lost.
5. Use quick booking when customer places booking.
6. Use quick close when sale is closed.
7. Management checks closed value and lot status summary.

Important site use case:

- If team sales is at site and customer asks about a lot, staff can search directly in CRM before promising availability.

## 5. Bumi Hayat Printing Workflow

1. Staff opens Bumi Hayat workspace.
2. Review new printing leads.
3. Collect requirement: category, quantity, size, artwork/mockup, deadline.
4. Prepare quotation.
5. Record deposit once customer confirms.
6. Update production status.
7. Update delivery or pickup status.
8. Close order when completed.

Main status movement:

New Lead -> Requirement Collected -> Quotation -> Deposit -> Production -> Delivered -> Completed

## 6. Barakah Emas Workflow

1. Staff opens Barakah Emas workspace.
2. Review daily leads.
3. Record customer interest and age range where relevant.
4. Select transaction type: sell gold, buy gold, new gold, used gold.
5. Enter gold type: 916 or 999.
6. Enter grams and price per gram.
7. Confirm total value and payment status.
8. Close order when payment is confirmed.

Gold rate note:

- Gold rate panel is a reference guide.
- Final selling/buying price should still follow company pricing rules.

## 7. Meta and TikTok Lead Flow

1. Customer submits lead form from ads.
2. Meta/TikTok sends webhook event to CRM.
3. CRM maps lead to company using page, form, advertiser, campaign, or configured mapping.
4. CRM stamps source and date automatically.
5. CRM assigns lead to company staff rotation.
6. Staff handles the lead from CRM.
7. Management monitors CPL and conversion from reports.

Fallback:

- If API spend is not ready, admin can use Add Spend manually.
- If webhook mapping is incomplete, lead can still be added manually.

## 8. Reporting Workflow

1. Click PDF Report.
2. Select company.
3. Select all staff or one staff.
4. Select monthly report or custom date range.
5. Download PDF.
6. Use report for daily review, weekly review, or management meeting.

Recommended reports:

- Daily: leads, follow-up, open queue.
- Weekly: staff performance and campaign CPL.
- Monthly: company sales, closed value, spend, CPL, and conversion.

## 9. Backup Workflow

1. Create code backup after major UI or logic changes.
2. Export runtime database after important sales/campaign updates.
3. Export spreadsheet backup before meeting or migration.
4. Keep backups in dated folders.
5. Do not edit backup files directly.

Backup should protect:

- Lead records
- Order records
- Campaign spend
- Integration mapping
- Auth profiles
- Control settings

## 10. Meeting Demo Flow

1. Open front page to show secure access layer.
2. Login as admin or management.
3. Show executive overview.
4. Switch between Salam Land, Bumi Hayat, and Barakah Emas.
5. Show one lead flow.
6. Show one order flow.
7. Show PDF report download.
8. Show lot board for Salam Land.
9. Explain future Meta/TikTok auto-lead connection.

## 11. Launch Readiness Checklist

- Front page does not show internal data before login.
- Login works on phone and laptop.
- Company access scope is correct.
- Staff can add/update lead.
- Staff can add/update order.
- Admin can add spend.
- PDF report works.
- Lot board works for Salam Land.
- Gold rate panel works for Barakah Emas.
- Backup exists before live campaign testing.
