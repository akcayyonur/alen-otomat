# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three roles, same login flow, very different usage context:

- **Yönetici (admin):** office staff who plan and track production — ürün kartları, iş emirleri, hammadde/sarfiyat, verimlilik, kalite kayıtları (GKK, ilk onay). Used at a desk, keyboard + mouse, data-dense screens, long sessions.
- **Fabrika operatörü (operator):** a **shared** account used at a **touchscreen PC/monitor mounted at/near the CNC machine** on the shop floor. Interactions: start/finish a work order, pick a duruş (downtime) reason, fill the Paketleme (packing) form, print a Ürün Tanıtım Kartı. Large touch targets matter; sessions are short, frequent, standing, often mid-task on the floor.
- **İzleyici (viewer):** read-only; may be a manager or an external stakeholder connecting remotely (Tailscale). Same screens as admin where permitted, no write actions ever shown.

## Product Purpose

CNC Telemetri Platformu reads live production data directly from the factory's CNC lathes (Syntec controllers, ARIX T-42CL) and shows it on a real-time dashboard (status, spindle/feed, part counts, cycle time) — replacing the previous "walk to the machine and look" approach. A second module, **Planlama**, layers production-management features on top (work orders, raw-material reservation, packing, quality/ölçü records, efficiency reports) to replace paper forms and Excel sheets the shop used before, because the factory's ERP (Mikro) cannot currently be written to from this system (read-only SQL export/Excel import today; a real write API exists but requires a Mikro license this installation does not yet have).

## Positioning

Not a market product — purpose-built for this one factory (Alen Otomat, a CNC machining shop producing brass/bronze fittings: somun, nipel, rakor, bağlantı parçaları for customers including Daikin). Its edge is exact fit to this shop's real paper forms and workflow (EYS.FR.005 Ölçü Kontrolü, EYS.FR.007 Paketleme, EYS.FR.011 GKK, EYS.FR.013 İlk Onay) rather than generic ERP/MES functionality.

## Operating Context

- 8 CNC lathes on the shop floor, one office PC running the backend, one factory-floor PC for the shared operator account, optional remote viewers over Tailscale.
- The physical artifacts this software replaces or drives: duruş kartı (downtime card), ürün tanıtım kartı (product ID card, printed and physically attached to each crate), paketleme formu, ölçü kontrolü föyü, GKK rapor numaraları, ilk onay raporu — all previously paper, several still co-exist as printed output from this system (A4/A5 printable forms).
- Factory floor is a working machine shop: noise, oily hands, operators standing and moving between tasks — not an office desk context, for the operator role specifically.
- The office/admin side is a normal desk environment with multi-hour sessions reviewing dense tables and reports.

## Capabilities and Constraints

- **Zero external dependency, no build step (hard constraint).** Backend: Node built-ins only (including `node:sqlite`). Dashboard: vanilla JS, no bundler, no framework, no `npm install` needed to run it. This must be preserved — any design-system work must ship as plain CSS/JS files served as-is, not a build pipeline.
- Real-time updates via Server-Sent Events (`/api/stream`), roughly once a second.
- Already has a working light/dark theme system via CSS custom properties (`:root`, `[data-theme="light"|"dark"]`, `prefers-color-scheme`) with a user-facing theme toggle — new work should extend this, not replace it.
- All user-facing text is Turkish; code identifiers are English. This is a fixed project rule, not a design choice.
- Role-based UI: admin/operator/viewer see different navigation and different action buttons on otherwise shared screens; a design system must express permission state clearly (e.g. a viewer must never see something that looks clickable but isn't).
- Operator surface specifically targets a touchscreen — large touch targets, minimal typing, few steps per task.
- `dashboard/format.js` is the existing single source of truth for field labels/formatting; `dashboard/styles.css` is the existing single stylesheet (~10k+ lines across the dashboard JS files combined).
- Printable outputs (A4/A5 forms) must still look right in print CSS, not just on screen.

## Evidence on Hand

- Full running application in this repository (`dashboard/*.js`, `dashboard/styles.css`) — the current look is real, working evidence, not a mockup.
- Real production data available via a local demo instance seeded from the factory's actual Mikro export (502 real products, 2,550 real order lines, real hammadde/stock codes) — already used this session to verify features end-to-end.
- No existing brand guide, logo file, or marketing materials; "Alen Otomat" is the company name, no further brand assets confirmed.

## Product Principles

1. Replace paper, exactly — screens mirror the real forms (EYS.FR.* kağıt formları) ustalar already know, not an abstract reimagining of the workflow.
2. Never lie about data you don't have — unknown values render as a visibly null state, not 0 or a guess (existing project-wide rule, applies to design too: null/unknown must look distinctly different from a real zero).
3. Two very different humans share this app: an office planner at a desk and an operator standing at a touchscreen mid-shift. One UI, two legitimate usage modes — don't optimize one at the other's expense.
4. Status and safety-relevant state (machine running/alarm/stopped, stock shortfall, tolerance-out-of-range) must be identifiable by more than color alone (icon + label + color), already a hard rule in this codebase.
5. Ship what's real today. The system is mid-build (several modules explicitly marked "gerçek tezgahta/sahada denenmedi" in project docs) — design should not imply certainty the data doesn't have.

## Accessibility & Inclusion

No specific accessibility requirement beyond good general practice (confirmed with the user). Status indicators must not rely on color alone (see Product Principles) — this is an existing functional requirement, not a formal a11y mandate.
