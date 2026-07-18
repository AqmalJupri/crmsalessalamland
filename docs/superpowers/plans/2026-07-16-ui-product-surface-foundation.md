# CRM UI and Product-Surface Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the PRD 1.8 visual/copy contract and a secure shared foundation for `crm.salamland.my` and `tasha.salamland.my`, including exact semantic tokens, concise Bahasa Melayu, explicit business-unit scope, host-specific navigation/metadata/PWA behavior, complete operational states, and responsive/accessibility evidence.

**Architecture:** One shared Next.js codebase produces two immutable surface-specific artifacts: one built with `PRODUCT_SURFACE=crm`, one with `PRODUCT_SURFACE=tasha`. The setting controls branding, route availability, navigation, metadata, manifest, and safe offline shell; it never controls data authorization. Server capability checks remain authoritative. Business-unit read scope is explicit in the URL, while unit changes are validated server-side and write commands remain bound to one permitted unit.

**Tech Stack:** Next.js 16.2.10 App Router, React 19.2.7, TypeScript 6.0.3, CSS custom properties, Lucide React 1.24.0, Vitest/Testing Library, Playwright/axe, and a dependency-free network-only service worker.

## Global Constraints

- The approved reference lock is PRD requirements `UX-001`–`UX-011`, `META-001`–`META-002`, and `PWA-001`–`PWA-002`. Do not reopen the palette or add a third surface.
- Exact primary roles: canvas `#F8FAFC`, surface `#FFFFFF`, sidebar `#0B172A`, raised sidebar `#1E293B`, text `#1E293B`, muted `#64748B`, divider `#E2E8F0`, action `#2563EB`, action hover `#1D4ED8`, Salam gold `#F59E0B`.
- Blue means action/selection. Gold means logo/brand/attention with dark text. Gold is never the generic primary CTA or generic success state.
- The UI is light, compact, data-led, and restrained. No violet/purple theme, decorative gradient, emoji icon, decorative side stripe, card-within-card, or generic card wrapper per section.
- Page titles are at most three words, navigation at most two, and action labels normally use verb + object in at most three words.
- Remove eyebrow, motivational, redundant subtitle, decorative note, and explanatory prose that does not orient, report status, prevent harm, or enable action.
- Errors keep cause and next step in at most two sentences. Destructive, financial, consent, privacy, and security confirmations retain target, consequence, and required reason.
- `Semua` is an authorised read-only scope. Any write requires a real unit selected and server validation; the browser cannot assert authorisation by changing a cookie or query string.
- Both surfaces use the same identity, API, and canonical records. Surface-specific hiding is not security.
- PWA code must never cache CRM HTML, API responses, record data, PII, files, tokens, or secrets.

---

## Task 1: Create an immutable, privacy-safe reference lock

**Files:**

- Create: `docs/design/reference/2026-07-16/REFERENCE.md`
- Create: `docs/design/reference/2026-07-16/tokens.json`
- Create: `docs/design/reference/2026-07-16/fonts.json`
- Create: `docs/design/reference/2026-07-16/tasha-desktop-1440.png`
- Create: `docs/design/reference/2026-07-16/tasha-mobile-390.png`
- Create: `docs/design/reference/2026-07-16/tasya-unavailable.png`
- Create: `docs/design/reference/2026-07-16/sha256.txt`
- Create: `scripts/design/hash-reference-pack.mjs`
- Create: `tests/ui/reference-pack.test.ts`
- Create: `tests/ci/vitest-config.test.ts`
- Modify: `vitest.config.ts`

- [ ] First extend `vitest.config.ts` test inclusion from the existing `src/**/*.test.ts` and `tests/ci/**/*.test.ts` patterns to also include `tests/ui/**/*.test.ts`. Add a config-source regression assertion so future changes cannot silently skip UI contract tests.
- [ ] Write a failing test that requires the exact token roles, capture date, reference origin/caveat, privacy declaration, locked official Inter release URL/version plus expected WOFF2/OFL checksums, and a valid SHA-256 entry for every committed reference artifact.

```ts
const requiredTokens = {
  canvas: "#F8FAFC",
  surface: "#FFFFFF",
  sidebar: "#0B172A",
  sidebarRaised: "#1E293B",
  text: "#1E293B",
  muted: "#64748B",
  divider: "#E2E8F0",
  action: "#2563EB",
  actionHover: "#1D4ED8",
  brandAttention: "#F59E0B",
};
```

- [ ] Run `pnpm exec vitest run tests/ui/reference-pack.test.ts`. Expected: FAIL because the pack does not exist.
- [ ] Record in `REFERENCE.md` that `tasya.salamdev.my` was unavailable because of a redirect loop and is not assumed to be the Tasha product. Bind the lock to PRD 1.8 tokens and the approved compact operational direction.
- [ ] Capture the reachable Tasha reference at 1440px desktop and 390px mobile plus dated evidence of the Tasya redirect-loop failure. Use only a logged-out view or locally sanitised capture; crop or irreversibly redact all customer, staff, amount, phone, email, address, document, provider, and internal identifier content before it enters the repository. If privacy-safe captures cannot be produced, leave this task and `UX-001` blocked rather than accepting a token-only pack. The test must fail if the reference directory contains unregistered files.
- [ ] Resolve Inter 400/500/600/700 and `OFL.txt` from one official tagged Inter release. Record the immutable upstream URL, tag, exact filenames, byte sizes, SHA-256 values, and license identifier in `fonts.json` before the reference pack is hashed; do not commit font binaries or modify the locked pack in this task.
- [ ] Make `hash-reference-pack.mjs` sort paths bytewise, hash file bytes with SHA-256, and refuse to hash `sha256.txt` itself.
- [ ] Generate `sha256.txt` and run `pnpm exec vitest run tests/ci/vitest-config.test.ts tests/ui/reference-pack.test.ts`. Expected: PASS with the UI suite discoverable and every privacy-safe reference artifact, token file, and font-provenance file registered by digest.
- [ ] Commit: `docs(ui): lock production visual reference`

## Task 2: Replace color names with exact semantic tokens

**Files:**

- Create: `src/styles/theme-contract.test.ts`
- Create: `tests/ui/font-assets.test.ts`
- Create: `public/fonts/inter-400.woff2`
- Create: `public/fonts/inter-500.woff2`
- Create: `public/fonts/inter-600.woff2`
- Create: `public/fonts/inter-700.woff2`
- Create: `public/fonts/OFL.txt`
- Modify: `src/styles/theme.css`
- Modify: `src/styles/product.css`

- [ ] Write a failing source contract test that extracts the `:root` block, asserts the exact primary roles, asserts accessibility-derived roles, and rejects direct hex/rgba colors outside the token declaration block.

Required derived roles:

```css
--crm-control-border: #64748b;
--crm-sidebar-text: #f8fafc;
--crm-sidebar-muted: #cbd5e1;
--crm-focus-ring: #2563eb;
--crm-success: #15803d;
--crm-success-surface: #f0fdf4;
--crm-danger: #b91c1c;
--crm-danger-surface: #fef2f2;
--crm-warning-text: #78350f;
--crm-warning-surface: #fffbeb;
```

- [ ] Run `pnpm exec vitest run src/styles/theme-contract.test.ts`. Expected: FAIL because the current canvas, field, amber CTA, green, line, and focus tokens do not match PRD 1.8.
- [ ] Replace colour-named aliases with purpose-named tokens. Migrate every CSS consumer; do not leave `--crm-amber`, `--crm-green`, `--crm-field`, `--crm-ink`, or `--crm-line` as a second theme authority.
- [ ] Make `.crm-button--primary` use action/action-hover and white text. Restrict `brand-attention` to the logo/brand and warning attention with dark text.
- [ ] Remove the decorative grid gradients from the login/background styles. Keep overlay shadows only where elevation is real.
- [ ] Download only the four Inter WOFF2 files and OFL named by the already locked `fonts.json`, verify their byte sizes/SHA-256 values before writing them under `public/fonts/`, and self-host them through `@font-face` with `font-display: swap`. Do not modify or rehash the reference pack in Task 2. `font-assets.test.ts` must verify WOFF2 signatures, four exact weights, locked checksums, local URLs, license presence, and absence of Google/runtime font requests.
- [ ] Ensure desktop controls are 36–40px, coarse-pointer controls are at least 44px, spacing follows 4/8px increments, radii remain 8–12px, and money/count values use tabular numerals.
- [ ] Add explicit `prefers-reduced-motion` behavior and test that no animation remains non-zero under reduced motion.
- [ ] Run the style contract, component tests, and `pnpm lint`. Expected: PASS.
- [ ] Commit: `feat(ui): apply approved semantic theme`

## Task 3: Make the product surface an explicit deployment contract

**Files:**

- Create: `src/config/product-surface.ts`
- Create: `src/config/product-surface.test.ts`
- Modify: `src/server/env.ts`
- Modify: `src/server/env.test.ts`
- Modify: `.env.example`
- Modify: `.github/workflows/quality.yml`
- Modify: `tests/ci/quality-workflow.test.ts`

- [ ] Write failing tests for the two valid surfaces, deployment environment, exact production-origin coherence, invalid surface, missing production setting, incoherent `NODE_ENV`/deployment combinations, non-canonical port, and non-canonical production origin.

```ts
export type ProductSurface = "crm" | "tasha";
export type DeploymentEnvironment = "local" | "ci" | "staging" | "production";

export interface ProductSurfaceSpec {
  key: ProductSurface;
  productName: "Salam CRM" | "Tasha";
  canonicalHost: "crm.salamland.my" | "tasha.salamland.my";
  titleTemplate: string;
  defaultBusinessUnitCode: "salam-land" | null;
}
```

- [ ] Run the product-surface/env tests. Expected: FAIL because `PRODUCT_SURFACE` and `DEPLOYMENT_ENVIRONMENT` are not parsed.
- [ ] Add `PRODUCT_SURFACE` and `DEPLOYMENT_ENVIRONMENT` to the Zod runtime schema and `RuntimeConfig`.
- [ ] When `DEPLOYMENT_ENVIRONMENT=production`, require `NODE_ENV=production` and exact `APP_URL.origin === https://${spec.canonicalHost}` with no explicit port. When `NODE_ENV=production`, forbid `DEPLOYMENT_ENVIRONMENT=local`. In every environment require `OIDC_REDIRECT_URI.origin === APP_URL.origin`.
- [ ] Set local defaults only in `.env.example`: `PRODUCT_SURFACE=crm`, `DEPLOYMENT_ENVIRONMENT=local`. Production runtime must receive explicit values.
- [ ] Set CI to build two immutable artifacts from the same commit: CRM with `PRODUCT_SURFACE=crm`, and Tasha with `PRODUCT_SURFACE=tasha`, both using `DEPLOYMENT_ENVIRONMENT=ci`. Apply database migrations once before the artifact matrix; neither build owns a database.
- [ ] Run env, workflow, typecheck, and production build tests. Expected: PASS.
- [ ] Commit: `feat(config): declare crm and tasha surfaces`

## Task 4: Enforce surface-specific navigation and server route availability

**Files:**

- Create: `src/config/product-navigation.ts`
- Create: `src/config/product-navigation.test.ts`
- Modify: `src/server/auth/module-access.ts`
- Modify: `src/server/auth/module-access.test.ts`
- Modify: `src/server/auth/page-access.ts`
- Modify: `src/server/auth/page-access.test.ts`
- Modify: `src/components/crm/application-shell.tsx`
- Modify: `src/components/crm/application-shell.test.ts`
- Create: `src/components/crm/surface-home.tsx`
- Create: `src/components/crm/surface-home.test.ts`
- Modify: `src/app/(crm)/layout.tsx`
- Modify: `src/app/(crm)/layout.test.ts`
- Modify: `src/app/(crm)/page.tsx`
- Modify: `src/app/(crm)/page.test.ts`
- Modify: `src/app/login/page.tsx`
- Create: `src/app/login/page.test.ts`
- Modify: `src/app/forbidden.tsx`
- Modify: `src/app/not-found.tsx`
- Create: `src/app/surface-errors.test.ts`

- [ ] Write failing tests that expect CRM navigation to include current sales/marketing/management modules and Tasha navigation to include only current Salam administration modules: root, Inventori, Pesanan, Kewangan, Tugasan, and Laporan. Do not expose the current integrations-style Tetapan screen as Tasha administration.
- [ ] Encode the route contract once:

```ts
export interface ProductNavigationItem {
  label: string;
  href: string;
  capability?: string;
  surfaces: readonly ProductSurface[];
}
```

- [ ] Run navigation and page-access tests. Expected: FAIL because the navigation is hard-coded in `ApplicationShell` and module access has no surface boundary.
- [ ] Move the navigation registry and route titles to `product-navigation.ts`; for this intermediate commit preserve the current active-unit capability filter while adding the surface filter. Task 5 atomically replaces it with selected-scope capability filtering.
- [ ] Add allowed surfaces to every `CRM_MODULE_ACCESS` entry. For this intermediate commit, preserve the current authenticated/capability layout guard while adding `404` for a route outside the surface. Task 5 atomically moves authentication and capability checks into the query-aware page helper and reduces module layouts to the immutable surface boundary, so no released final state loses a deep-link query or lacks a server guard.
- [ ] Pass `getRuntimeConfig().productSurface` from the server layout into `ApplicationShell`. Use product names `Salam CRM` and `Tasha`; do not infer the surface from an untrusted request `Host` header.
- [ ] Make login, forbidden, not-found, topbar, and root home surface-aware. Tasha's home is a focused Salam Land exception/admin queue and must never render CRM Lead/Pipeline metrics; with no real production read model it renders a truthful empty/unknown state, not synthetic authority.
- [ ] Keep unfinished future Tasha modules absent from navigation and routes. Do not add static screens that imply lots, agreements, collections, or documents are implemented.
- [ ] Run focused unit tests and both product-surface builds. Expected: PASS.
- [ ] Commit: `feat(ui): separate crm and tasha navigation`

## Task 5: Replace the cycling company control with an explicit server-validated menu

**Files:**

- Create: `src/domain/business-units/read-scope.ts`
- Create: `src/domain/business-units/read-scope.test.ts`
- Create: `src/server/auth/business-scope.ts`
- Create: `src/server/auth/business-scope.test.ts`
- Create: `tests/integration/viewer-business-scope.test.ts`
- Create: `src/components/crm/business-unit-switcher.tsx`
- Create: `src/components/crm/business-unit-switcher.test.ts`
- Create: `src/app/api/v1/auth/business-unit/route.ts`
- Create: `src/app/api/v1/auth/business-unit/route.test.ts`
- Create: `src/app/(crm)/scoped-pages-contract.test.ts`
- Modify: `src/proxy.ts`
- Create: `src/proxy.test.ts`
- Modify: `src/components/crm/sidebar.tsx`
- Modify: `src/components/crm/application-shell.tsx`
- Modify: `src/components/crm/application-shell.test.ts`
- Modify: `src/server/auth/session.ts`
- Modify: `src/server/auth/viewer.ts`
- Modify: `src/server/auth/viewer.test.ts`
- Modify: `src/server/auth/page-access.ts`
- Modify: `src/server/auth/page-access.test.ts`
- Modify: `src/app/(crm)/layout.tsx`
- Modify: `src/app/(crm)/layout.test.ts`
- Modify: `src/app/(crm)/page.tsx`
- Modify: `src/app/(crm)/page.test.ts`
- Modify: `src/app/(crm)/finance/page.tsx`
- Modify: `src/app/(crm)/inventory/page.tsx`
- Modify: `src/app/(crm)/leads/page.tsx`
- Modify: `src/app/(crm)/leads/page.test.ts`
- Modify: `src/app/(crm)/marketing/page.tsx`
- Modify: `src/app/(crm)/orders/page.tsx`
- Modify: `src/app/(crm)/pipeline/page.tsx`
- Modify: `src/app/(crm)/pipeline/page.test.ts`
- Modify: `src/app/(crm)/reports/page.tsx`
- Modify: `src/app/(crm)/settings/page.tsx`
- Modify: `src/app/(crm)/tasks/page.tsx`
- Modify: `src/app/(crm)/team/page.tsx`
- Modify: `src/components/crm/leads-workspace.tsx`
- Modify: `src/components/crm/leads-workspace.test.ts`
- Modify: `src/components/crm/pipeline-workspace.tsx`
- Modify: `src/components/crm/pipeline-workspace.test.ts`
- Modify: `src/components/crm/operational-module.tsx`
- Create: `src/components/crm/operational-module.test.ts`
- Modify: `src/components/crm/metric.tsx`
- Create: `src/components/crm/metric.test.ts`
- Modify: `src/lib/demo-crm.ts`
- Modify: `src/lib/demo-crm.test.ts`
- Modify: `src/app/api/v1/leads/route.ts`
- Modify: `src/app/api/v1/leads/route.test.ts`
- Modify: `src/app/api/v1/leads/[id]/route.ts`
- Modify: `src/app/api/v1/leads/[id]/route.test.ts`
- Modify: `src/server/leads/schemas.ts`
- Modify: `src/server/leads/schemas.test.ts`
- Modify: `src/server/leads/create-lead.ts`
- Modify: `src/server/leads/transition-lead.ts`

- [ ] Write failing pure tests for `Semua`, valid unit codes, missing scope, duplicate code, unknown/unauthorised unit, Tasha's Salam-only boundary, URL serialization, and write-disabled all scope. `Semua` must contain only the units where the requested module capability is granted; it never means every unit in the organisation.

```ts
export interface ViewerBusinessUnitAccess extends ViewerBusinessUnit {
  membershipIds: readonly string[];
  capabilities: readonly string[];
  capabilityRecordScopes: CapabilityRecordScopes;
}

export type BusinessUnitReadScope =
  | {
      kind: "ALL";
      queryValue: "all";
      units: readonly ViewerBusinessUnitAccess[];
      unitIds: readonly string[];
      writable: false;
    }
  | {
      kind: "UNIT";
      queryValue: string;
      businessUnitId: string;
      businessUnitCode: string;
      access: ViewerBusinessUnitAccess;
      writable: true;
    };

export function resolveAuthorizedBusinessScope(
  viewer: Viewer,
  requestedCode: string | readonly string[] | null,
  surface: ProductSurface,
  capability?: string,
): BusinessUnitReadScope;
```

- [ ] Extend `getViewer()` to derive `businessUnitAccess` for every visible unit from its active unit-specific plus organisation-wide memberships and roles. Keep the current active-unit `capabilities`, `capabilityRecordScopes`, `activeMembershipId`, and `membershipIds` for compatibility, but never reuse them to authorise another unit. Prove with PostgreSQL integration fixtures that `lead.read` in Salam Land does not grant Lead access in Bumi Hayat or Barakah Emas.
- [ ] In `proxy.ts`, reject multiple `bu` values, empty values, values over 64 bytes, and anything outside `all|[a-z0-9]+(?:-[a-z0-9]+)*` with a minimal `400`/`no-store` response before layouts or authentication. Never echo the value. Keep the same validation inside the page helper as defence in depth. `resolveAuthorizedBusinessScope` accepts raw `string | string[] | null` so multiplicity cannot be collapsed in tests. With a module capability, include only per-unit access entries containing it; with no root capability, include only active membership-backed units and let each dashboard widget enforce its own module capability. Restrict Tasha to `salam-land`. A syntactically valid but unauthorised code returns `403`; omitted scope selects the authorised active unit or first authorised unit deterministically. `requireWriteBusinessUnit(scope)` rejects `ALL`.
- [ ] Add `requireScopedPageViewer(rawBu, capability, returnToPath)`, returning `{ viewer, scope }`. It first rejects malformed/multiple scope values, then constructs the safe return target itself as `<returnToPath>?bu=<validated-code-or-all>`. In the same commit, reduce every module layout to surface-only and move authentication/capability enforcement into this helper, so an unauthenticated `/leads?bu=barakah-emas` returns to that exact safe scope after OIDC and no layout redirects first. Call it from every page listed above before selecting any fixture or future read-model data. The source contract test must fail if a scoped page omits the helper, discards duplicate query values, or uses `viewer.businessUnitId` as its read scope.
- [ ] Pass a minimal `businessUnitAccess` projection from the server root layout into `ApplicationShell` and test that no membership/internal constraint data crosses the client boundary. Make the shell resolve the current route's capability from the shared navigation registry. For a unit scope, show only navigation items granted by that unit and offer only units granting the active module capability. For `Semua`, show a module when at least one included unit grants it and compute that destination's own authorised unit set on navigation. Preserve the safe `bu` value in links. Never filter navigation from active-cookie `viewer.capabilities`, and never offer a company option that the target page will immediately reject.
- [ ] Add the business-unit code/name to demo Lead, Opportunity, Task, Activity, KPI, and operational rows. Filter synthetic fixtures by `scope.unitIds`. In `Semua`, every table row, pipeline item, queue item, and metric drill-down must expose a visible company badge/column; never combine indistinguishable records from different units.
- [ ] Replace the loose KPI props with a tested `MetricScope` contract carrying exact unit codes/IDs, date basis, period, timezone, `asOf`, freshness state, optional attribution model, metric-definition link, and authorised drill-down URL. Every metric visibly states its date/business scope and truthful freshness. `Semua` KPI aggregation uses only unit IDs authorised for that metric's module capability and its drill-down preserves the scoped query.

```ts
export interface MetricScope {
  businessUnitIds: readonly string[];
  businessUnitCodes: readonly string[];
  dateBasis: string;
  periodLabel: string;
  timezone: "Asia/Kuala_Lumpur";
  asOf: string;
  freshness: "fresh" | "stale" | "unknown";
  attributionModel: string | null;
  definitionHref: string;
  drilldownHref: string;
}
```
- [ ] Write component tests requiring a real menu/combobox with `Semua`, `Salam Land`, `Bumi Hayat`, and `Barakah Emas`; arrow-key navigation, Escape, outside click, focus return, selected state, and no cycling behavior.
- [ ] Write route tests for trusted origin, bounded JSON body, authenticated viewer, allowed/unknown unit, CSRF failure, server-set cookie attributes, and no change on failure.
- [ ] Run the focused tests. Expected: FAIL because the switcher cycles and writes `document.cookie`.
- [ ] Implement `POST /api/v1/auth/business-unit` with `{ businessUnitId }`. Validate against `viewer.businessUnitAccess`, update the active session unit, and set `crm_bu` as `Secure` in production, `HttpOnly`, `SameSite=Lax`, `Path=/`, and bounded by session expiry. This endpoint stores a preference; it does not grant a capability.
- [ ] Make the UI call the endpoint only for a unit selection. `Semua` changes the `bu=all` URL parameter without changing the server's active write unit.
- [ ] Preserve other query parameters and browser back/forward behavior. Unit selections persist as `bu=<business-unit-code>`; never put UUIDs, customer data, or amounts in URLs.
- [ ] In all scope, hide or disable create/edit actions with the concise label `Pilih syarikat`. A command payload must still carry one explicit `businessUnitId`; the query string and preference cookie are never command authority.
- [ ] Add `requireApiViewerForBusinessUnit(capability, businessUnitId)`. It must derive a unit-specific command viewer from `businessUnitAccess`, including the correct membership IDs and record scopes, or return `403`. Make Lead creation parse and validate the bounded body before calling this helper. Make Lead transition require `businessUnitId`, authorise that exact unit, and match both Lead ID and unit inside the transaction so the record cannot be moved through another unit's active cookie. Keep command-service tenant/unit checks as defence in depth.
- [ ] Run focused tests, auth integration tests, and E2E back/forward/deep-link tests. Expected: PASS.
- [ ] Commit: `feat(ui): add explicit business unit scope`

## Task 6: Remove decorative copy and redundant card structure

**Files:**

- Create: `src/components/crm/unsaved-changes-dialog.tsx`
- Create: `src/components/crm/unsaved-changes-dialog.test.ts`
- Create: `src/components/crm/user-menu.tsx`
- Create: `src/components/crm/user-menu.test.ts`
- Modify: `src/components/crm/topbar.tsx`
- Modify: `src/components/crm/app-shell.tsx`
- Modify: `src/components/crm/app-shell.test.ts`
- Modify: `src/components/crm/application-shell.tsx`
- Modify: `src/components/crm/application-shell.test.ts`
- Modify: `src/components/crm/operational-module.tsx`
- Modify: `src/components/crm/operational-module.test.ts`
- Modify: `src/components/crm/leads-workspace.tsx`
- Modify: `src/components/crm/leads-workspace.test.ts`
- Modify: `src/components/ui/table.tsx`
- Create: `src/components/ui/table.test.ts`
- Modify: `src/server/auth/viewer.ts`
- Modify: `src/server/auth/viewer.test.ts`
- Modify: `src/app/(crm)/page.tsx`
- Modify: `src/app/(crm)/page.test.ts`
- Modify: `src/app/(crm)/localized-copy.test.ts`
- Create: `src/app/(crm)/concise-copy-contract.test.ts`
- Modify: `src/styles/theme.css`
- Modify: `src/styles/product.css`

- [ ] Write a failing source/DOM contract that rejects `eyebrow`, `topbarDescription`, redundant page subtitles, decorative notes, motivational phrases, emoji characters, decorative gradients, and nested generic card/table wrappers.
- [ ] Run `pnpm exec vitest run 'src/app/(crm)/concise-copy-contract.test.ts' src/components/crm/operational-module.test.ts src/components/crm/leads-workspace.test.ts src/components/crm/unsaved-changes-dialog.test.ts src/components/crm/user-menu.test.ts src/components/ui/table.test.ts`. Expected: FAIL on the current copy/wrappers, `window.confirm`, missing field focus/captions, and missing session menu.
- [ ] Remove `eyebrow` and `description` from `TopbarProps` and remove `topbarEyebrow`/`topbarDescription` from `AppShellProps`; they are not part of the operational shell contract.
- [ ] Keep one visible page title, direct controls, data/state, and necessary safeguards. Metadata descriptions remain head-only and must not render as page copy.
- [ ] Change `OperationalModule` from `Card > CardHeader > CardContent > Table` to a simple section header followed by the already bounded table surface:

```tsx
<section className="crm-record-section" aria-labelledby={headingId}>
  <header className="crm-record-section__header">
    <h2 id={headingId}>{title}</h2>
    <Badge variant="neutral">{rows.length}</Badge>
  </header>
  <Table responsive="stack">{tableChildren}</Table>
</section>
```

- [ ] Keep KPI cards because each is a self-contained metric unit. Keep dialogs, record tiles, and pipeline items because their boundaries support interaction. Remove a card when its only job is to wrap a heading or another already bounded surface.
- [ ] Replace `window.confirm` in `LeadsWorkspace` with `UnsavedChangesDialog`. The dialog names the unsaved form, states that the changes will be discarded, traps focus, supports Escape/cancel, restores focus, and requires the explicit `Buang perubahan` action; backdrop clicks must not silently discard data.
- [ ] Map API validation errors to their matching form controls, render the message beside the field, set `aria-invalid`/`aria-describedby`, and focus the first invalid control. Keep a concise form-level alert only for errors that cannot be assigned to a field.
- [ ] Add a visually hidden `TableCaption` to every Lead, dashboard, and operational table and keep semantic column scopes. Replace the mobile one-card-per-row transformation with compact divider rows or a deliberately labelled horizontal table region; do not create a nested card for every record.
- [ ] Add an accessible user menu to the top bar with the real display name, current session status/expiry, and `Log keluar`. Extend `Viewer` with the actual session expiry selected from `sessions.expiresAt`; do not show a fabricated health or profile state. Logout calls the existing same-origin `POST /api/v1/auth/logout`, handles failure without destroying the current screen, and returns focus when dismissed.
- [ ] Replace generic `Belum ada data.` with module-specific one-line empty text only where it improves orientation; allow at most one CTA.
- [ ] Run concise-copy, component, localized-copy, and E2E tests. Expected: PASS.
- [ ] Commit: `refactor(ui): distill operational screens`

## Task 7: Implement the complete operational state vocabulary

**Files:**

- Create: `src/components/ui/operation-state.tsx`
- Create: `src/components/ui/operation-state.test.ts`
- Create: `src/app/__ui-test__/states/page.tsx`
- Create: `src/app/__ui-test__/states/page.test.ts`
- Modify: `src/components/ui/index.ts`
- Modify: `src/components/crm/data-empty-state.tsx`
- Modify: `src/components/crm/application-shell.tsx`
- Modify: `src/app/(crm)/page.tsx`
- Modify: `src/app/(crm)/finance/page.tsx`
- Modify: `src/app/(crm)/inventory/page.tsx`
- Modify: `src/app/(crm)/leads/page.tsx`
- Modify: `src/app/(crm)/marketing/page.tsx`
- Modify: `src/app/(crm)/orders/page.tsx`
- Modify: `src/app/(crm)/pipeline/page.tsx`
- Modify: `src/app/(crm)/reports/page.tsx`
- Modify: `src/app/(crm)/settings/page.tsx`
- Modify: `src/app/(crm)/tasks/page.tsx`
- Modify: `src/app/(crm)/team/page.tsx`

- [ ] Write failing accessibility tests for these exact states:

```ts
export type OperationStateKind =
  | "loading"
  | "empty"
  | "filtered-empty"
  | "stale"
  | "syncing"
  | "queued"
  | "partial"
  | "success"
  | "failed"
  | "conflict"
  | "offline"
  | "forbidden"
  | "unknown";
```

- [ ] Run `pnpm exec vitest run src/components/ui/operation-state.test.ts src/app/__ui-test__/states/page.test.ts`. Expected: FAIL because the state component and fail-closed synthetic gallery do not exist.

- [ ] Define a concise Malay default label and one matching Lucide icon for each state. State meaning must never depend on color alone.
- [ ] Use `role=status`/polite live regions for progress/success, `role=alert` only for actionable failures, and normal regions for static empty/unknown states.
- [ ] Convert `DataEmptyState` into a compatibility wrapper around `OperationState kind="empty"` and migrate pages to explicit state kinds.
- [ ] Add a synthetic state gallery only for browser acceptance. It must return `404` unless `CRM_DEMO_MODE=true`, `NODE_ENV !== "production"`, and `DEPLOYMENT_ENVIRONMENT` is explicitly `local` or `ci`; it is absent from navigation, accepts no query/body data, reads no database/session, and renders one fixed synthetic instance of every state. Unit tests must prove production, staging, non-demo, and unknown environments fail closed.
- [ ] Replace the static production sidebar `Tersambung` badge. Until a real timestamped integration health check exists, render `Tidak diketahui` or omit the health badge; demo mode may say `Demo`.
- [ ] Ensure financial/destructive/consent/security failures retain target, consequence, reason, and next step even when the general copy contract is concise.
- [ ] Run component, page, axe, and screen-reader-name tests. Expected: PASS.
- [ ] Commit: `feat(ui): add truthful operational states`

## Task 8: Add private metadata, host-specific manifests, and safe offline behavior

**Files:**

- Create: `src/app/manifest.ts`
- Create: `src/app/offline/page.tsx`
- Create: `src/components/pwa/service-worker-registration.tsx`
- Create: `src/components/pwa/service-worker-registration.test.ts`
- Create: `public/sw.js`
- Create: `public/icons/crm-192.png`
- Create: `public/icons/crm-512.png`
- Create: `public/icons/crm-maskable-512.png`
- Create: `public/icons/crm-apple-touch-icon.png`
- Create: `public/icons/crm-favicon.ico`
- Create: `public/icons/tasha-192.png`
- Create: `public/icons/tasha-512.png`
- Create: `public/icons/tasha-maskable-512.png`
- Create: `public/icons/tasha-apple-touch-icon.png`
- Create: `public/icons/tasha-favicon.ico`
- Create: `tests/ui/pwa-assets.test.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/(crm)/page.tsx`
- Modify: `src/app/(crm)/finance/page.tsx`
- Modify: `src/app/(crm)/inventory/page.tsx`
- Modify: `src/app/(crm)/leads/page.tsx`
- Modify: `src/app/(crm)/marketing/page.tsx`
- Modify: `src/app/(crm)/orders/page.tsx`
- Modify: `src/app/(crm)/pipeline/page.tsx`
- Modify: `src/app/(crm)/reports/page.tsx`
- Modify: `src/app/(crm)/settings/page.tsx`
- Modify: `src/app/(crm)/tasks/page.tsx`
- Modify: `src/app/(crm)/team/page.tsx`
- Modify: `next.config.ts`
- Modify: `tests/production/runtime-smoke.mjs`
- Modify: `tests/e2e/crm.spec.ts`

- [ ] Write failing asset tests that parse PNG headers and require exact 192×192 and 512×512 dimensions, valid square maskable art with safe-zone metadata, non-empty favicon/apple assets, and these exact surface-specific manifest values: `lang: "ms"`, `start_url: "/"`, `scope: "/"`, `display: "standalone"`, `background_color: "#F8FAFC"`, `theme_color: "#0B172A"`, the correct surface name/short name, and icons whose `purpose` includes `maskable` where applicable.
- [ ] Write failing runtime tests requiring `X-Robots-Tag: noindex, nofollow, noarchive`, PII-free route titles, `lang=ms`, light color scheme, `theme-color=#0B172A`, and no metadata description rendered in visible page text. Extend `runtime-smoke.mjs` to assert the surface title, allowed/forbidden route boundary, manifest, private robots header, service-worker response, exact migration readiness ledger, `404` for `/__ui-test__/states`, and zero cross-surface navigation leakage.
- [ ] Run `pnpm exec vitest run tests/ui/pwa-assets.test.ts src/components/pwa/service-worker-registration.test.ts`. Expected: FAIL because the manifest, surface assets, registration component, and worker do not exist.
- [ ] Generate restrained S/T monogram assets from the locked navy/gold roles. Do not use customer data, photographs, gradients, or tiny text inside icons.
- [ ] Make `generateMetadata` and `manifest()` consume the explicit product-surface spec:

```ts
title: {
  default: spec.productName,
  template: `%s · ${spec.productName}`,
},
robots: "noindex, nofollow, noarchive"
```

- [ ] Add `X-Robots-Tag` to every application response through `next.config.ts`, including errors and assets where applicable. Mount `ServiceWorkerRegistration` once in the root layout and register only the root-owned `/sw.js` on secure/localhost origins.
- [ ] Implement `public/sw.js` without CacheStorage. For navigation, API, files, and assets, request the network with `cache: "no-store"`. When a navigation fails, return a minimal unstyled Malay unavailable response whose headers include `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow, noarchive`, and `Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`. Its HTML must also contain `<meta name="robots" content="noindex,nofollow,noarchive">`; `next.config.ts` cannot protect a response created by the worker. Never call `caches.open`, `cache.match`, or `cache.put`.
- [ ] Make the offline page one safe line with no record context, URL echo, user name, cached metrics, or retry queue claim.
- [ ] Add E2E coverage that creates a synthetic record, goes offline, proves CacheStorage remains empty, and confirms the safe unavailable response contains no record value or user identity.
- [ ] Run asset, metadata, runtime-smoke, service-worker, and offline E2E tests. Expected: PASS.
- [ ] Commit: `feat(pwa): add private host-specific app shells`

## Task 9: Expand responsive, keyboard, and visual regression evidence

**Execution status:** Automated responsive/keyboard/visual contracts, fail-closed hydration diagnostics, clean forced-fresh Linux capture, manual review of all 60 PNGs and provenance promotion are complete through `2ed7379`. Fifty-five assets were byte-identical and five contained accepted antialias-only differences; standard comparison run `29661378588` passed with zero real hydration/caret diagnostic, flaky test, retry or screenshot mismatch. The task remains open only for the named human screen-reader evidence required below.

**Files:**

- Modify: `playwright.config.ts`
- Modify: `package.json`
- Create: `tests/e2e/ui-contract.spec.ts`
- Create: `tests/e2e/ui-states.spec.ts`
- Create: `tests/e2e/ui-visual.spec.ts`
- Create: `tests/e2e/__snapshots__/` assets generated only from the reviewed Linux Playwright runtime
- Create: `docs/design/evidence/ui-foundation-screen-reader.md`
- Create: `scripts/ci/run-next-runtime-smoke.mjs`
- Create: `tests/ci/runtime-process.test.ts`
- Modify: `.github/workflows/quality.yml`
- Modify: `tests/ci/quality-workflow.test.ts`

- [ ] First extend `tests/ci/quality-workflow.test.ts` to require two isolated surface commands/ports, seven viewport declarations, no server reuse, surface-namespaced artifacts, sequential workflow execution, and failure-only short-retention artifacts. Run `pnpm exec vitest run tests/ci/quality-workflow.test.ts`. Expected: FAIL against the current one-server/two-project setup.
- [ ] Make the Playwright configuration require `E2E_PRODUCT_SURFACE` and `E2E_PORT`, set its base URL/web server from that port, use a surface-namespaced snapshot/output/report path, and always set `reuseExistingServer: false`. Add seven explicit Chromium projects: 320×800, 375×812, 390×844, 768×1024, 1024×768, 1280×800, and 1440×900. The 320/375/390 projects must set `isMobile: true` and `hasTouch: true` so coarse-pointer rules are exercised. Keep Chromium pinned by Playwright 1.61.1.
- [ ] Replace the single-surface script with deterministic sequential commands. `test:e2e:crm` runs the CRM surface alone on port 3201, `test:e2e:tasha` runs Tasha alone on port 3202, and `test:e2e` runs those two scripts sequentially with a clean `.next` boundary. Each script must set a synthetic PostgreSQL URL, matching `APP_URL`, an at-least-32-character test hash key, `CRM_DEMO_MODE=true`, `DEPLOYMENT_ENVIRONMENT=local`, `PRODUCT_SURFACE`, `E2E_PRODUCT_SURFACE`, and `E2E_PORT`; no local `.env` value may decide which surface was tested.

```json
{
  "test:e2e": "pnpm test:e2e:crm && pnpm test:e2e:tasha",
  "test:e2e:crm": "pnpm clean:next && DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_ui APP_URL=http://127.0.0.1:3201 AUTH_HASH_KEY=ui-e2e-auth-hash-key-0123456789abcdef CRM_DEMO_MODE=true DEPLOYMENT_ENVIRONMENT=local PRODUCT_SURFACE=crm E2E_PRODUCT_SURFACE=crm E2E_PORT=3201 playwright test",
  "test:e2e:tasha": "pnpm clean:next && DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_ui APP_URL=http://127.0.0.1:3202 AUTH_HASH_KEY=ui-e2e-auth-hash-key-0123456789abcdef CRM_DEMO_MODE=true DEPLOYMENT_ENVIRONMENT=local PRODUCT_SURFACE=tasha E2E_PRODUCT_SURFACE=tasha E2E_PORT=3202 playwright test"
}
```
- [ ] Add tests for login, each surface's root, Leads/Pipeline and the current settings/integrations view only on CRM, the Salam administration modules only on Tasha, the business-unit menu, forbidden/not-found routing, and surface-specific metadata/manifest. The CRM integrations visual must show a truthful timestamped health signal or `Tidak diketahui`, never a static ready state; prove the screen/label is absent on Tasha. Exercise every operational state only through Task 7's fixed, production-disabled synthetic state gallery; Task 8's production runtime smoke proves the same route is unavailable. Assert the other surface's routes and labels are absent rather than visiting a route that does not belong to that surface.
- [ ] At all seven widths assert no horizontal page overflow and no clipped menu/dialog. At 320, 390, 768, 1024, and 1440 capture reviewed screenshots for login, CRM dashboard, Leads, Pipeline, switcher, CRM integrations/unknown-health, Tasha home/admin, and representative production states. Exercise 200% zoom/reflow, keyboard-only completion, visible focus, logical focus return, accessible icon-only names, and zero axe Critical/Serious violations.
- [ ] In the touch projects, assert the browser-computed pointer mode is coarse and interactive targets compute to at least 44×44 CSS pixels. In every surface run, assert the browser-computed canvas, surface, sidebar, text, action, and focus-ring values equal the locked tokens; source-text matching alone is insufficient.
- [ ] Generate screenshot baselines in the same Linux Playwright runtime used by CI. Review every baseline against the reference lock before committing it; never accept a changed baseline merely to make CI green.
- [ ] Use a small explicit diff allowance only for antialiasing. Mask clocks/random request IDs, never customer data. Fail on missing or extra UI elements.
- [ ] Upload the Playwright report, traces, and changed screenshots only on failure; apply short artifact retention and confirm synthetic data only.
- [ ] Manually complete the named screen-reader evidence sheet on the reviewed build. Record reviewer, date, OS, browser, screen reader/version, and pass/fail notes for login, navigation, company scope, Lead create/error/discard, operational state announcement, user menu, and logout. Task 9 remains open until the evidence is signed; axe and accessible-name tests do not replace this journey.
- [ ] Implement `run-next-runtime-smoke.mjs` as the one macOS/Linux runtime owner. It spawns `pnpm start` with Node `child_process.spawn({ detached: true })`, waits for the configured `/api/health/live`, runs `pnpm test:runtime` with the matching `PRODUCTION_SMOKE_URL`, verifies `/api/health/ready`, and always sends `SIGTERM` then bounded `SIGKILL` to the negative child PID before it exits. Handle success, startup failure, smoke failure, timeout, `SIGINT`, and `SIGTERM`; never use the host-dependent `setsid` binary or kill only the shell wrapper. The focused process test must use a synthetic parent/grandchild fixture and prove both PIDs are gone after every path.
- [ ] Run `pnpm test:e2e:crm`, then `pnpm test:e2e:tasha`, then the aggregate `pnpm test:e2e`. Expected: PASS across all seven widths and both isolated surface processes, with no reused server.
- [ ] Commit: `test(ui): lock responsive and accessibility evidence`

## Task 10: Verify the complete UI foundation

**Execution status:** Engineering verification, independent code/design/provenance reviews, hydration-clean forced-fresh hosted capture and standard comparison are complete through `2ed7379`; standard run `29661378588` passed every job with unit 937/937, production 1,367/1,367, database 601/601, CRM browser 200 pass/38 skip and Tasha browser 113 pass/125 skip, with zero real hydration/caret diagnostic, flaky test, retry or screenshot mismatch. Task 9's named human screen-reader sign-off remains a separate open human acceptance item. No production release gate is implied.

**Files:**

- Modify only when fresh evidence reveals a defect in a file owned by Tasks 1-9.

- [ ] Run focused unit tests for reference pack, theme, surface config/navigation, read scope, switcher, concise copy, operation states, manifests, PWA assets, and service worker.
- [ ] Run `pnpm lint` and `pnpm typecheck`.
- [ ] Run `pnpm test:coverage` and `pnpm test:coverage:production`; add meaningful cases if new production files reduce either enforced threshold.
- [ ] Apply reviewed migrations to the isolated `crm_salam_codex_ui` database, then build → start → smoke → stop each surface before cleaning its output. Use this exact macOS/Linux sequence locally and in Linux CI; do not delete one surface build before its smoke run.

```bash
set -euo pipefail

export NODE_ENV=production
export DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_ui
export TEST_DATABASE_URL="$DATABASE_URL"
export AUTH_HASH_KEY=ci-auth-hash-key-0123456789abcdef
export OIDC_ISSUER=https://identity.example.test
export OIDC_CLIENT_SECRET=ci-oidc-client-secret-0123456789abcdef
export DEPLOYMENT_ENVIRONMENT=ci
export CRM_DEMO_MODE=false

pnpm db:migrate
pnpm db:migrate

build_and_smoke_surface() {
  surface="$1"
  host="$2"
  client_id="$3"
  port="$4"
  export PRODUCT_SURFACE="$surface"
  export APP_URL="https://$host"
  export OIDC_CLIENT_ID="$client_id"
  export OIDC_REDIRECT_URI="https://$host/api/v1/auth/oidc/callback"
  runtime_log="/tmp/crm-ui-$surface-runtime.log"

  pnpm clean:next
  pnpm build
  node scripts/ci/run-next-runtime-smoke.mjs \
    --port "$port" \
    --log "$runtime_log"
}

build_and_smoke_surface crm crm-ci.example.test crm-ci 3301
build_and_smoke_surface tasha tasha-ci.example.test tasha-ci 3302
```

- [ ] Mirror that lifecycle in the quality workflow with distinct logs/ports and the portable process-group teardown test. Expected: both Task 8 runtime smoke contracts pass, each readiness check sees the exact reviewed migration ledger, every spawned parent/grandchild is gone after success or failure, and no process or `.next` output is reused across surfaces.
- [ ] Run `pnpm test:e2e:crm`, `pnpm test:e2e:tasha`, and aggregate `pnpm test:e2e`; inspect the five required screenshot widths plus the 375/1280 overflow results, axe output, keyboard/touch behavior, offline cache, metadata, manifests, and response headers.
- [ ] Search the final production source for old theme tokens, direct colour literals, emoji, decorative gradients, `eyebrow`, static `Tersambung`, `document.cookie`, and visible redundant descriptions.
- [ ] Request independent UI/code/accessibility review. Resolve every Critical or Important finding through a failing regression test.
- [ ] Commit review corrections separately and push the verified branch.

Expected final result: both product surfaces have a truthful, compact, reference-locked foundation that is safe to extend with real CRM/Tasha modules. This plan does not claim the business workflows or production release gates are complete.

## Inputs needed before visual acceptance, not before Tasks 2-8

- A privacy-safe desktop and mobile capture of the intended `tasya.salamdev.my` reference if that hostname becomes reachable, or explicit confirmation that the PRD 1.8/Tasha provisional lock is final.
- Named product/design/accessibility reviewers for the immutable reference pack and Linux visual baselines.
- Final approved CRM and Tasha icon artwork if the restrained S/T monograms are not accepted as the production marks.

If these inputs remain unavailable, implementation may pass automated foundation tests but `UX-001` and the visual portion of `UX-011` remain open rather than silently self-approved.
