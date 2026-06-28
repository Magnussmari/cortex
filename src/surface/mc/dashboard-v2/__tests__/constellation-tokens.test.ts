/**
 * MC-D1 (cortex#1288) — constellation skin token + motion presence guard.
 *
 * The skin's view slices (D2–D5) consume `constellation.css` by NAME: a
 * dropped token or renamed keyframe would silently break a downstream pane
 * with no type error to catch it (it's CSS). This test pins the contract:
 * the required tokens, keyframes, the `.mc-skin` scope choice, and the
 * reduced-motion guard must all stay present.
 *
 * It also enforces the "additive, no `:root` restyle" invariant — the skin
 * must NOT declare its palette on a bare `:root`, which would override the
 * live dashboard's tokens.css.
 */
import { test, expect } from "bun:test";

const cssPath = new URL("../styles/constellation.css", import.meta.url).pathname;
const css = await Bun.file(cssPath).text();

/** Required design tokens (exact custom-property names the mockup defines). */
const REQUIRED_TOKENS = [
  "--bg", "--panel", "--panel2", "--line", "--lsoft",
  "--fg", "--dim", "--faint",
  "--mer", "--tide",
  "--ok", "--warn", "--bad",
  "--d", "--a", "--h",
  "--mono", "--sans",
];

/** Required keyframes (the motion contract D2–D5 reference by name). */
const REQUIRED_KEYFRAMES = [
  "corePulse", "coreSlow", "haloBreathe",
  "dashFlow", "dashFlowFed",
  "attnBlink", "ticker", "barSweep", "spin",
];

test("every required design token is declared", () => {
  for (const token of REQUIRED_TOKENS) {
    expect(css).toContain(`${token}:`);
  }
});

test("every required keyframe is defined", () => {
  for (const name of REQUIRED_KEYFRAMES) {
    expect(css).toContain(`@keyframes ${name}`);
  }
});

test("tokens are scoped under the .mc-skin wrapper, not bare :root", () => {
  // The opt-in wrapper must exist...
  expect(css).toContain(".mc-skin {");
  // ...and the skin must NOT re-declare the palette on a bare :root selector
  // (that would override the live dashboard's tokens.css — a flag-day restyle).
  expect(css).not.toMatch(/(^|\})\s*:root\b/);
});

test("a prefers-reduced-motion guard disables the animations", () => {
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(css).toContain("animation: none");
});

test("glow primitives + flow dash geometry are present", () => {
  expect(css).toContain("--glow-core");
  expect(css).toContain("--glow-halo");
  expect(css).toContain("--edge-dash");
  expect(css).toContain("radial-gradient"); // node radial glow + atmosphere
});
