# CRM Salam Fortress PRD and Workflow

Last updated: 2026-05-05
Production URL: https://salamland.my

## 1. Product Direction

CRM Salam Fortress is a private multi-company CRM built for Salam Land Development, Bumi Hayat Printing, and Barakah Emas.

The product is not a public marketing website. It is an internal operating system for leads, orders, staff performance, campaign spend, reports, integrations, and backup control.

Core direction:

- Clean minimalist corporate interface.
- Double-layer access flow: public secure front page first, CRM dashboard only after login.
- One website for all companies, but each company keeps separate workspace, staff, product flow, and reporting.
- Mobile, tablet, laptop, and PC layouts must remain readable and usable.

## 2. Company Scope

### Salam Land Development

Business: property and land sales.

Main goals:

- Track land leads from Meta, TikTok, WhatsApp, and manual input.
- Monitor lot availability, booking, closed lots, and buyer type.
- Show staff sales performance and campaign CPL.

Key data:

- Customer name
- Phone number
- Source and campaign
- Staff/team sales
- Land project
- Lot number
- Bumi/Non-Bumi
- Land price
- Booking amount
- IC front/back reference
- Site visit date
- Status and closed value

### Bumi Hayat Printing

Business: sportswear and printing orders.

Main goals:

- Track printing leads by category, quantity, quotation, deposit, production, and delivery.
- Keep the workflow focused on real factory/order movement.
- Monitor sales by team and campaign.

Key data:

- Customer name
- Phone number
- Product category
- Quantity
- Size breakdown
- Artwork/mockup status
- Fabric/material
- Quotation amount
- Deposit
- Balance
- Deadline
- Delivery or pickup status

### Barakah Emas

Business: gold sales and gold transaction tracking.

Main goals:

- Track gold leads, buyer interest, transaction type, grams, price per gram, and payment.
- Show daily lead count and conversion.
- Display reference gold rates for 916 and 999.

Key data:

- Customer name
- Phone number
- Age range
- Transaction type
- Gold type 916/999
- New or used gold
- Buy from customer or sell to customer
- Gram
- Price per gram
- Total value
- Payment status
- Receipt reference
- Pickup or delivery status

## 3. Access Model

The system uses one login layer with role-based access.

Access roles:

- Admin: full access to all companies, settings, integrations, backup, reports, and records.
- Management: full visibility across all companies for review and decision making.
- Staff Salam: Salam Land workspace only.
- Staff BH: Bumi Hayat workspace only.
- Staff BE: Barakah Emas workspace only.

Security rules:

- Username and password must not appear on the front page.
- Public users must not see CRM data before login.
- Staff accounts must open directly into their own company workspace.
- Admin and management can view all company performance.
- Integration and backup controls should only be available for admin or management.

## 4. Front Page Double-Layer Flow

The system must open in two layers.

Layer 1: Secure Front Page

- Shows CRM Salam Fortress branding.
- Shows a short secure-access message.
- Shows system trust points such as HTTPS live, role-based access, and backup ready.
- Shows only one main Sign in action.
- Does not show company dashboard, lead count, order data, staff ranking, lot board, or campaign data.
- Works cleanly on phone, tablet, laptop, and PC.

Layer 2: CRM Workspace

- Opens only after successful login.
- Shows sidebar navigation, company workspace, dashboard cards, company flow, leads, orders, reports, and settings.
- Staff users see only their own company.
- Admin and management see executive overview and all companies.

## 5. Navigation Structure

Main CRM navigation:

- Dashboard
- Pipeline
- Publish
- Library
- Input
- Reports
- Automation
- Settings
- Records

Navigation behavior:

- Sidebar should remain clean and readable.
- Mobile layout should avoid squeezing the sidebar into the same view as dashboard content.
- Important actions should be easy to tap on phone.
- Dashboard should not overflow horizontally on small screens.

## 6. Daily Operating Workflow

1. User opens https://salamland.my.
2. User lands on secure front page.
3. User clicks Sign in.
4. System authenticates username and password.
5. System routes user based on role.
6. Staff user opens company workspace only.
7. Admin or management opens all-company view.
8. User reviews dashboard, lead queue, order queue, and follow-up due.
9. User updates lead/order status.
10. Management reviews reports and campaign performance.

## 7. Lead Workflow

Lead source options:

- Meta Ads
- TikTok Ads
- WhatsApp Business
- Manual input
- Future Google Ads

Default lead flow:

1. Lead enters CRM.
2. System stamps date, source, campaign, company, and status.
3. System assigns lead to the correct company/team.
4. Staff contacts customer.
5. Staff updates status and next follow-up.
6. Lead converts to order when serious.
7. Order is closed, lost, or kept in follow-up.

Automation target:

- Auto-capture lead date and source.
- Auto-map company by campaign/form/source.
- Auto-assign staff by company rotation.
- Auto-calculate total leads, open queue, closed sales, spend, and CPL.
- Auto-prepare follow-up reminders.

## 8. Order Workflow

Order data should stay company-specific.

Salam Land order:

- Customer details
- Interested project
- Lot number
- Lot price
- Booking amount
- Bumi/Non-Bumi
- IC references
- Site visit and closing status

Bumi Hayat order:

- Customer details
- Product category
- Quantity
- Size breakdown
- Mockup/artwork status
- Quotation
- Deposit and balance
- Production status
- Delivery/pickup status

Barakah Emas order:

- Customer details
- Gold type
- New/used gold
- Transaction type
- Gram
- Price per gram
- Total value
- Payment status
- Receipt reference

## 9. Reporting Workflow

PDF reports must support:

- Company report.
- Staff/team sales report.
- Monthly report.
- Custom date range report.
- Leads, orders, closed value, spend, CPL, and follow-up due.

Report design requirement:

- Clean header.
- Company name and selected period.
- Clear metric cards.
- Status breakdown.
- Staff performance table.
- Campaign spend and CPL summary.
- Recent records section.

## 10. Integration Workflow

Production base URL:

```text
https://salamland.my
```

Meta webhook:

```text
https://salamland.my/api/webhooks/meta
```

Meta verify token:

```text
crm-salam-fortress-meta
```

TikTok webhook:

```text
https://salamland.my/api/webhooks/tiktok
```

TikTok secret:

```text
crm-salam-fortress-tiktok
```

Integration goal:

- Meta and TikTok lead events should enter CRM automatically once account tokens, forms, and mapping are completed.
- Campaign spend should be connected through available API/token support where possible.
- Manual spend input remains available as backup if API data is delayed.

## 11. Backup Workflow

Backup must include:

- Full code archive.
- Production runtime database.
- Auth/user access database.
- Google Sheets/Excel export backup.
- Manifest describing backup contents.

Recommended cadence:

- Code backup after every major release.
- Runtime database backup daily during active campaigns.
- Report/data export before management meetings.

## 12. Acceptance Checklist

- Domain opens at https://salamland.my.
- Front page does not reveal CRM data before login.
- Login works on phone, tablet, laptop, and PC.
- Admin login can access all companies.
- Management login can access all companies.
- Staff Salam opens Salam Land only.
- Staff BH opens Bumi Hayat only.
- Staff BE opens Barakah Emas only.
- Dashboard cards do not overflow on mobile.
- PDF report downloads correctly.
- Salam Land lot board can search booking/closed/available lots.
- Barakah Emas gold reference panel loads.
- Meta webhook endpoint responds.
- TikTok webhook endpoint responds.
- Backup files are available and recoverable.
