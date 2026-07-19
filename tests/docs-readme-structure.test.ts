import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readTestOutputSync } from "./helpers/cli";

/**
 * Spec: @readme-landing-page
 *
 * Verifies the README is a concise landing page with the required sections
 * and cross-links, and that it does not embed guides, concept explanations,
 * or reference content.
 */

const projectRoot = resolve(dirname(__dirname));
const readme = readTestOutputSync(join(projectRoot, "tests", "..", "README.md"));

// Extract all markdown headings (## level) for section checks
const h2Headings = [...readme.matchAll(/^## .+$/gm)].map((m) => m[0]);

// Extract all markdown links: [text](target)
const allLinks = [...readme.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((m) => ({
  text: m[1],
  href: m[2],
}));

describe("README landing page structure", () => {
  // AC: @readme-landing-page ac-1
  it("contains an overview section at the top", () => {
    // The README should start with an H1 and an overview paragraph
    expect(readme).toMatch(/^# kspec\n/);
    // Overview paragraph should exist before any H2
    const firstH2Index = readme.indexOf("\n## ");
    const overviewText = readme.slice(0, firstH2Index);
    expect(overviewText).toContain("spec-first");
  });

  // AC: @readme-landing-page ac-1
  it("contains an install section", () => {
    const hasInstall = h2Headings.some((h) => /install/i.test(h));
    expect(hasInstall, "README should have an install section").toBe(true);
    // Should include the npm install command
    expect(readme).toContain("npm install -g @kynetic-ai/spec");
  });

  // AC: @readme-landing-page ac-1
  it("contains a first-steps section with commands", () => {
    const hasFirstSteps = h2Headings.some((h) => /first.step|quick.start|getting.started/i.test(h));
    expect(hasFirstSteps, "README should have a first-steps section").toBe(true);
    // Should include the core bootstrap commands
    expect(readme).toContain("kspec init");
    expect(readme).toContain("kspec setup");
  });

  // AC: @readme-landing-page ac-1
  it("contains a cross-links section", () => {
    const hasDocsSection = h2Headings.some((h) => /doc|links|where.to|next/i.test(h));
    expect(hasDocsSection, "README should have a documentation/links section").toBe(true);
  });

  // AC: @readme-landing-page ac-1
  it("does not embed guides, concept explanations, or reference content", () => {
    // Should NOT have detailed workflow explanations
    expect(readme).not.toContain("## The spec-first loop");
    expect(readme).not.toContain("## How it works");
    expect(readme).not.toContain("## Why teams use it");
    // Should NOT have subsection headers that indicate embedded concept content
    expect(readme).not.toContain("### Specs stay separate");
    expect(readme).not.toContain("### Tasks stay linked");
    expect(readme).not.toContain("### Agents get the same context");
    // Should NOT have multi-step command sequences that belong in a guide
    expect(readme).not.toContain("kspec item add");
    expect(readme).not.toContain("kspec derive");
    expect(readme).not.toContain("kspec task submit");
    expect(readme).not.toContain("kspec task complete");
  });

  // AC: @readme-landing-page ac-1
  it("is concise (under 40 lines of content)", () => {
    const nonEmptyLines = readme.split("\n").filter((line) => line.trim().length > 0);
    expect(nonEmptyLines.length).toBeLessThanOrEqual(40);
  });
});

describe("INSTALL.md links", () => {
  const install = readTestOutputSync(join(projectRoot, "INSTALL.md"));
  const installLinks = [...install.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    .map((m) => ({ text: m[1], href: m[2] }))
    .filter((l) => !l.href.startsWith("http"));

  it("all relative links point to files that exist", () => {
    expect(installLinks.length).toBeGreaterThan(0);

    for (const link of installLinks) {
      const targetPath = join(projectRoot, link.href.split("#")[0]);
      expect(
        existsSync(targetPath),
        `Link "${link.text}" points to ${link.href} which does not exist`,
      ).toBe(true);
    }
  });

  it("all anchors resolve to headings in the target file", () => {
    const anchoredLinks = installLinks.filter((l) => l.href.includes("#"));

    for (const link of anchoredLinks) {
      const [file, anchor] = link.href.split("#");
      const target = readTestOutputSync(join(projectRoot, file));
      const headingSlugs = [...target.matchAll(/^#+ (.+)$/gm)].map((m) =>
        m[1]
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-"),
      );
      expect(
        headingSlugs,
        `Anchor "${link.href}" in INSTALL.md does not match any heading in ${file}`,
      ).toContain(anchor);
    }
  });
});

describe("README cross-links into docs", () => {
  // AC: @readme-landing-page ac-2
  it("links to Getting Started", () => {
    const gsLink = allLinks.find((l) => l.href.includes("getting-started"));
    expect(gsLink, "README should link to Getting Started").toBeDefined();
  });

  // AC: @readme-landing-page ac-2
  it("links to Concepts", () => {
    const conceptsLink = allLinks.find((l) => l.href.includes("concepts"));
    expect(conceptsLink, "README should link to Concepts").toBeDefined();
  });

  // AC: @readme-landing-page ac-2
  it("links to Guides", () => {
    const guidesLink = allLinks.find((l) => l.href.includes("guides"));
    expect(guidesLink, "README should link to Guides").toBeDefined();
  });

  // AC: @readme-landing-page ac-2
  it("all documentation links point to files that exist", () => {
    const docsLinks = allLinks.filter((l) => l.href.startsWith("docs/") || l.href === "INSTALL.md");
    expect(docsLinks.length).toBeGreaterThan(0);

    for (const link of docsLinks) {
      const targetPath = join(projectRoot, link.href);
      expect(
        existsSync(targetPath),
        `Link "${link.text}" points to ${link.href} which does not exist`,
      ).toBe(true);
    }
  });
});
