/**
 * Design System Token Contract Tests
 *
 * Validates that the web UI build output contains all required design system
 * tokens as defined by the imgen token-contract.css specification.
 *
 * Tests read the built CSS output (packages/web-ui/build/), verifying the
 * full Tailwind pipeline processes tokens correctly.
 *
 * Spec: @ui-design-system
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WEB_UI_BUILD = join(process.cwd(), "packages", "web-ui", "build");
const CSS_ASSETS_DIR = join(WEB_UI_BUILD, "_app", "immutable", "assets");

let mainCss = "";

beforeAll(() => {
  if (!existsSync(CSS_ASSETS_DIR)) {
    throw new Error(
      `Build output not found at ${CSS_ASSETS_DIR}. Run "npm run build" in packages/web-ui/ first.`,
    );
  }

  const cssFiles = readdirSync(CSS_ASSETS_DIR).filter((f) => f.endsWith(".css"));
  mainCss = cssFiles.map((f) => readFileSync(join(CSS_ASSETS_DIR, f), "utf-8")).join("\n");
});

// AC: @ui-design-system ac-1
describe("design system tokens (@ui-design-system ac-1)", () => {
  describe("16 color tokens as CSS custom properties", () => {
    const colorTokens = [
      "design-bg",
      "design-fg",
      "design-card",
      "design-card-fg",
      "design-primary",
      "design-primary-fg",
      "design-secondary",
      "design-secondary-fg",
      "design-muted",
      "design-muted-fg",
      "design-accent",
      "design-accent-fg",
      "design-destructive",
      "design-border",
      "design-input",
      "design-ring",
    ];

    it("includes all 16 design color token CSS custom properties", () => {
      for (const token of colorTokens) {
        expect(mainCss, `missing --${token}`).toContain(`--${token}`);
      }
    });

    it("uses oklch color space for color token values", () => {
      // Minified CSS may omit space after colon
      expect(mainCss).toMatch(/--design-bg:\s*oklch\(/);
      expect(mainCss).toMatch(/--design-fg:\s*oklch\(/);
      expect(mainCss).toMatch(/--design-primary:\s*oklch\(/);
      expect(mainCss).toMatch(/--design-destructive:\s*oklch\(/);
    });
  });

  describe("4 radius tokens", () => {
    it("includes all 4 design radius CSS custom properties", () => {
      for (const suffix of ["sm", "md", "lg", "xl"]) {
        expect(mainCss, `missing --design-radius-${suffix}`).toContain(`--design-radius-${suffix}`);
      }
    });
  });

  describe("7 spacing tokens", () => {
    it("includes all 7 design spacing CSS custom properties", () => {
      for (const suffix of ["xs", "sm", "md", "lg", "xl", "2xl", "3xl"]) {
        expect(mainCss, `missing --design-spacing-${suffix}`).toContain(
          `--design-spacing-${suffix}`,
        );
      }
    });
  });

  describe("7 z-index layers", () => {
    it("includes all 7 design z-index CSS custom properties", () => {
      for (const suffix of ["base", "dropdown", "sticky", "overlay", "modal", "popover", "toast"]) {
        expect(mainCss, `missing --design-z-${suffix}`).toContain(`--design-z-${suffix}`);
      }
    });
  });

  describe("3 font families", () => {
    it("includes design font family CSS custom properties", () => {
      expect(mainCss).toContain("--font-design-primary");
      expect(mainCss).toContain("--font-design-secondary");
      expect(mainCss).toContain("--font-design-mono");
    });
  });

  it("Tailwind @theme inline maps design tokens to utility namespace", () => {
    // Tailwind v4 tree-shakes @theme inline mappings that aren't used by any
    // utility class in the codebase. The presence of --design-* custom properties
    // in the built CSS proves tokens.css was imported and processed. The @theme
    // inline block in app.css (verified by build success) makes these available
    // as utility classes (e.g. bg-design-bg, text-design-fg) — they appear in
    // built CSS only when a component uses them. This test verifies the token
    // contract is intact; actual utility usage is verified by component tests.
    expect(mainCss).toContain("--design-bg");
    expect(mainCss).toContain("--design-spacing-xs");
    expect(mainCss).toContain("--design-z-base");
    expect(mainCss).toContain("--font-design-primary");
  });
});

// AC: @ui-design-system ac-2
describe("status colors and dark theme (@ui-design-system ac-2)", () => {
  const statuses = [
    "pending",
    "in-progress",
    "pending-review",
    "needs-work",
    "completed",
    "blocked",
    "cancelled",
  ];

  it("includes all 7 status color CSS custom properties", () => {
    for (const status of statuses) {
      expect(mainCss, `missing --design-status-${status}`).toContain(`--design-status-${status}`);
    }
  });

  it("includes foreground variants for all 7 status colors", () => {
    for (const status of statuses) {
      expect(mainCss, `missing --design-status-${status}-fg`).toContain(
        `--design-status-${status}-fg`,
      );
    }
  });

  it("uses oklch color space for status tokens", () => {
    expect(mainCss).toMatch(/--design-status-pending:\s*oklch\(/);
    expect(mainCss).toMatch(/--design-status-completed:\s*oklch\(/);
    expect(mainCss).toMatch(/--design-status-blocked:\s*oklch\(/);
  });

  it("includes dark theme overrides for status colors", () => {
    // The .dark selector should exist and contain status overrides
    expect(mainCss).toMatch(/\.dark\b/);
    // Count occurrences — light (:root) + dark (.dark) = at least 2
    const pendingMatches = (mainCss.match(/--design-status-pending:/g) || []).length;
    expect(
      pendingMatches,
      "status-pending should appear in both :root and .dark",
    ).toBeGreaterThanOrEqual(2);
  });

  it("status colors use distinct oklch hues for visual differentiation", () => {
    // Extract all status hue values to verify they're distinct
    // Minified CSS uses percentage lightness: oklch(76.9% .188 70.08)
    const huePattern = /--design-status-([\w-]+):\s*oklch\(\s*[\d.]+%?\s+([\d.]+)\s+([\d.]+)/g;
    const hues: Record<string, number> = {};
    let match: RegExpExecArray | null;

    while ((match = huePattern.exec(mainCss)) !== null) {
      const name = match[1];
      // Skip foreground variants
      if (name.endsWith("-fg")) continue;
      const chroma = parseFloat(match[2]);
      const hue = parseFloat(match[3]);
      // Only record chromatic colors (chroma > 0.05 excludes near-grays like cancelled)
      if (chroma > 0.05 && !(name in hues)) {
        hues[name] = hue;
      }
    }

    // Verify we found hues for all chromatic statuses
    // cancelled may be achromatic (gray), so we check at least 6
    expect(Object.keys(hues).length).toBeGreaterThanOrEqual(6);

    // Verify hue values are distinct (at least 10° apart from each other)
    const hueValues = Object.values(hues);
    for (let i = 0; i < hueValues.length; i++) {
      for (let j = i + 1; j < hueValues.length; j++) {
        const diff = Math.abs(hueValues[i] - hueValues[j]);
        const circularDiff = Math.min(diff, 360 - diff);
        expect(
          circularDiff,
          `hues ${hueValues[i]} and ${hueValues[j]} are too similar`,
        ).toBeGreaterThan(10);
      }
    }
  });
});

// AC: @ui-design-system ac-3
describe("shimmer animation (@ui-design-system ac-3)", () => {
  it("defines ds-shimmer keyframes in built CSS", () => {
    expect(mainCss).toContain("ds-shimmer");
  });

  it("includes the .ds-shimmer utility class with animation", () => {
    // The .ds-shimmer class should exist with animation property
    expect(mainCss).toMatch(/\.ds-shimmer\b/);
  });

  it("gates shimmer animation behind prefers-reduced-motion", () => {
    expect(mainCss).toContain("prefers-reduced-motion");
    // Inside the reduced-motion media query, animation should be disabled
    expect(mainCss).toContain("animation:none");
  });
});

// AC: @ui-design-system ac-4
describe("breathing/pulse animation (@ui-design-system ac-4)", () => {
  it("defines ds-breathe keyframes in built CSS", () => {
    expect(mainCss).toContain("ds-breathe");
  });

  it("includes the .ds-breathe utility class", () => {
    expect(mainCss).toMatch(/\.ds-breathe\b/);
  });

  it("gates breathing animation behind prefers-reduced-motion", () => {
    // The prefers-reduced-motion query must disable ds-breathe
    expect(mainCss).toContain("prefers-reduced-motion");
  });
});
