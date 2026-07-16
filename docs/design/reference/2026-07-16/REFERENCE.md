# Production UI reference lock — 2026-07-16

This directory is the immutable visual reference lock for PRD 1.8 and its approved **compact operational** direction. It records evidence and provenance; it is not an invitation to average together unrelated visual styles or to infer product behavior not present in the PRD.

## Reference hierarchy

1. The approved PRD 1.8 semantic roles in `tokens.json` are the primary design authority.
2. The logged-out Tasha surface at <https://tasha.salamland.my/> is the primary real-product visual evidence for responsive composition, dark framing, light surfaces, and action emphasis.
3. Official Inter release v4.1 provenance in `fonts.json` is the typography authority.
4. The Tasya failure evidence is availability evidence only. `tasya.salamdev.my` was unavailable because of a redirect loop and is **not assumed to be the Tasha product**.

Live Refero research was unavailable, so this lock uses the approved PRD tokens plus real Tasha/Tasya browser evidence without introducing an unsupported design variant.

## Capture record

Capture date: **2026-07-16**.

The browser-control workflow was attempted first, but no attachable browser was available: the browser list was empty and setup returned `No browser is available`. The approved fallback used the repository's installed Playwright with local headless Chromium.

| Artifact | Origin and observation | Viewport |
| --- | --- | --- |
| `tasha-desktop-1440.png` | Tasha returned HTTP 200 at the requested origin and rendered its logged-out sign-in surface. | 1440 × 1000 |
| `tasha-mobile-390.png` | The same logged-out Tasha origin rendered at the mobile lock width. | 390 × 844 |
| `tasya-unavailable.png` | Navigation to Tasya mechanically failed with `net::ERR_TOO_MANY_REDIRECTS`; only after that assertion passed was the dated evidence panel rendered. | 1024 × 768 |

The Tasya panel is deliberately labelled as generated evidence rather than represented as server-rendered content. Its failure does not establish any visual or product relationship between Tasya and Tasha.

## Privacy declaration

No credentials were entered and no authenticated session was used. Before either Tasha PNG was written, every rendered non-whitespace text character was **irreversibly redacted** into a solid block. Images, video, canvas, iframes, embeds, and CSS background images were suppressed before rasterisation. The privacy/date banner was injected only after sanitisation. No unsanitised Tasha screenshot was written into this repository, and no customer, staff, amount, phone, email, address, document, provider, or internal identifier content is retained in these captures.

The source view was inspected visually after capture: only solid redaction marks, empty controls, structural surfaces, and the injected privacy/date banner remain. The unrelated local screenshot containing live-looking records was explicitly excluded from the pack.

## Reference locks

- Preserve the exact semantic role values in `tokens.json`; downstream names may alias them but may not silently change their meaning.
- Preserve the dark framing/light surface relationship, compact operational density, restrained dividers, blue primary action, and amber attention role evidenced by the approved tokens and safe captures.
- Preserve responsive intent at the locked 1440px and 390px widths; the captures are evidence, not pixel-perfect implementation fixtures.
- Use Inter 400/500/600/700 only from the pinned v4.1 commit recorded in `fonts.json`. Font binaries and `OFL.txt` are intentionally not committed by this task.
- Do not treat the Tasya evidence panel, redaction blocks, live content, or browser error styling as product UI direction.

## Decision ledger

| Decision | Reason | Authority |
| --- | --- | --- |
| Lock PRD token roles verbatim | Prevents visual drift while implementation is still being built. | Approved PRD 1.8 |
| Use safe, logged-out Tasha captures at both target widths | Grounds structure in the reachable product without retaining live data. | Real Tasha origin, 2026-07-16 |
| Solid-redact all rendered text and suppress media before writing | Makes privacy removal irreversible at the committed-pixel level. | Task privacy requirement |
| Record Tasya only as unavailable | A redirect loop is not evidence of identity or visual direction. | Mechanical browser navigation result |
| Pin Inter files to a release commit and byte digest | Makes later font acquisition reproducible without committing binaries now. | Official `rsms/inter` v4.1 release |

## Integrity

`sha256.txt` registers every artifact in this directory except itself. Paths are bytewise sorted and digests are computed from raw file bytes. Rebuild it from the repository root with:

```sh
node scripts/design/hash-reference-pack.mjs
```

The generator refuses an explicit request to hash `sha256.txt` into itself. Any change to a locked artifact requires an intentional new manifest and review; normal implementation work must not edit this dated pack.
