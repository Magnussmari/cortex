# MC UX — the Mission Control "constellation" skin

**Build spec for the MC visual overhaul · realises `docs/vision-mission-control.md` · from the claude-design mockup**
**Status:** design (approved direction, 2026-06-28) · **Mockup:** [`docs/mockups/mc-constellation/`](mockups/mc-constellation/) (`mission-control.dc.html` + `preview.webp`)

---

## What this is

The vision (the fly bridge / Internet of Agentic Work) now has a **concrete visual language**. This doc is the build spec to re-skin the MC Network view to it. The skin sits **on top of the A-wave data model** (#1274 networks-first-class + ADMITTED roster ⋈ presence + encryption posture + Pier queue) — the A-wave is the *truth*; this is the *presentation*.

It is a dark, glowing **constellation / star-map** of the agentic network, with an **altitude rail**, a **you-are-here breadcrumb**, **posture-awareness** (admin vs member), and **live bus traffic** animated on the edges.

## Design tokens (from the mockup — OKLCH, dark)

```css
--bg:     oklch(0.13 0.012 250)    /* near-black blue */
--panel:  oklch(0.175 0.012 252)   --panel2: oklch(0.215 0.013 252)
--line:   oklch(0.33 0.013 252)    --lsoft:  oklch(0.255 0.012 252)
--fg:     oklch(0.94 0.006 250)    --dim: oklch(0.66 …)  --faint: oklch(0.50 …)   /* text hierarchy */
--mer:    oklch(0.76 0.13 224)     /* network accent A (cyan-blue, "Meridian") */
--tide:   oklch(0.72 0.13 288)     /* network accent B (violet) */
--ok:     oklch(0.80 0.13 162)  --warn: oklch(0.82 0.13 78)  --bad: oklch(0.66 0.20 22)
--d/--a/--h: 158 / 80 / 8           /* extra per-network / per-capability accent hues */
--mono: 'JetBrains Mono'   --sans: 'Inter'
```
Background is a radial-gradient "atmosphere"; nodes are radial-gradient glows; per-network hue keys the whole subtree (node + edges + labels), mirroring the stack-color system already in MC.

**Motion** (keyframes in the mockup): `corePulse`/`coreSlow`/`haloBreathe` (node liveness glow) · `dashFlow`/`dashFlowFed` (**live bus traffic** flowing along edges) · `attnBlink` (attention) · `ticker`/`barSweep`/`spin`. Gate all of it behind the `atmosphere` + `liveTraffic` toggles (the mockup's `data-props`) — and `prefers-reduced-motion`.

## Anatomy (what's on the glass)

- **Command bar (64px):** ◎ MISSION CONTROL · `PRINCIPAL <name>` · `ALT` you-are-here **breadcrumb** (`NETWORK·OF·NETWORKS / Meridian / aria·atlas`) · right-aligned **posture pill** (`OPERATOR` / `MEMBER`).
- **Altitude rail (left):** vertical selector — **NETWORKS (10k ft) → NETWORK → STACK → ASSISTANT → SESSION** — the primary navigation gesture; current level lit.
- **Constellation canvas (main):** the network as a glowing graph. A **network header** (`MERIDIAN · YOU OPERATE · 2 STACKS · K7`). **Nodes** = stacks/assistants (radial glow, capability label e.g. `code-review`, state e.g. `⚠ rate-limited`, the `● YOU ARE HERE` anchor). **Edges** = bus relationships; **federated edges** dashed + flowing, labelled `● federated · admitted peer · K7`.

## The two postures (first-class, per the mockup's `posture` prop)

- **OPERATOR** (a network you own): the network header reads `YOU OPERATE`; admin affordances present (roster, Pier queue, grant, rotate). 
- **MEMBER** (a network you joined): your slice + admitted peers; no admin affordances.
The posture pill in the command bar + the posture conditional (admin/member) drive which chrome appears.

## How it maps to the A-wave data (skin ⟷ truth)

| Skin element | Data source (A-wave) |
|---|---|
| Network header + roster | A1 `/api/networks` (networks-first-class + ADMITTED roster ⋈ presence) |
| Node state (present / absent / pending / `present-but-unadmitted`) | A1 membership verdict |
| `YOU OPERATE` / posture pill | A1 posture (admin vs member) |
| `K7` / encryption-key + sealed badge | A3 (#1277) encryption posture |
| Pier queue (pending requests) | B1 (#1278) |
| Live peer roster (member posture) | Q3 (#1282) registry ADMITTED read |
| Edge "live traffic" (`dashFlow`) | bus comms (presence/dispatch/review envelopes) |

The skin **renders the A-wave's truth** — it never invents liveness (vision north-star: *truth, not theater*).

## Build slices (D-series — sequence AFTER the A-wave to avoid re-skinning churn)

- **D1 — Design system / tokens.** New additive token + motion layer (`styles/tokens.css` or a tokens module): the OKLCH palette, JetBrains Mono + Inter, the keyframes, glow primitives, reduced-motion guard. *Conflict-free (new file) — can land in parallel with the A-wave.*
- **D2 — Shell chrome.** Command bar (logo · principal · ALT breadcrumb · posture pill) + the left **altitude rail**. Mostly new components.
- **D3 — Constellation canvas.** Re-skin the network graph to the glowing star-map (radial-glow nodes, capability + state labels, you-are-here, dashed federated edges). The centerpiece; **re-skins the A-wave's network-view/canvas/nodes → lands after the A-wave settles.**
- **D4 — Posture + trust indicators.** Admin/member chrome, `YOU OPERATE`, the `K7` encryption indicator, `federated · admitted peer` edge labels. Consumes A1 + A3 + Q3.
- **D5 — Live traffic + atmosphere.** Animated bus-comm edges (`dashFlow` driven by real envelope flow) + the atmosphere glow + the `liveTraffic`/`atmosphere` toggles + reduced-motion.

**Sequencing:** D1 ∥ A-wave (additive). D2 next. D3→D4→D5 after the A-wave data lands (they re-skin the same components A1/A3/B1 build). Deploy the skin as one coherent wave so the pane doesn't ship half-reskinned.

## North-stars (carry from the vision)
Calm under complexity · altitude is the primary gesture · **truth, never theater** · posture-aware · always reach the envelope · sovereign by default (interiors never leave their stack) · honour `prefers-reduced-motion`.
</content>
