/**
 * Build the plugin/ directory from templates/skills/ for npm distribution.
 *
 * Reads the skill manifest and package.json, then generates:
 * - plugin/.claude-plugin/plugin.json (with version from package.json)
 * - plugin/.claude-plugin/marketplace.json (marketplace listing for directory source)
 * - plugin/plugins/kspec/skills/<id>/SKILL.md (with YAML frontmatter prepended)
 *
 * Clean-rebuild: removes plugin/ first to prune stale skills.
 */

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("yaml");

const ROOT = path.resolve(__dirname, "..");
const TEMPLATES_DIR = path.join(ROOT, "templates", "skills");
const PLUGIN_DIR = path.join(ROOT, "plugin");
const MANIFEST_PATH = path.join(TEMPLATES_DIR, "manifest.yaml");
const PACKAGE_JSON_PATH = path.join(ROOT, "package.json");

function main() {
  // Read package.json for version
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf-8"));
  const version = packageJson.version;

  // Read manifest
  const manifestContent = fs.readFileSync(MANIFEST_PATH, "utf-8");
  const manifest = yaml.parse(manifestContent);

  if (!manifest || !Array.isArray(manifest.skills)) {
    console.error("No skills found in manifest.yaml");
    process.exit(1);
  }

  // Clean rebuild: remove plugin/ entirely
  if (fs.existsSync(PLUGIN_DIR)) {
    fs.rmSync(PLUGIN_DIR, { recursive: true, force: true });
  }

  // Create plugin/.claude-plugin/
  const pluginMetaDir = path.join(PLUGIN_DIR, ".claude-plugin");
  fs.mkdirSync(pluginMetaDir, { recursive: true });

  // Write plugin.json
  const pluginJson = {
    name: "kspec",
    version,
    description: "kspec agent skills",
  };
  fs.writeFileSync(
    path.join(pluginMetaDir, "plugin.json"),
    JSON.stringify(pluginJson, null, 2) + "\n",
    "utf-8"
  );

  // Write marketplace.json (required by Claude Code for directory source marketplaces)
  const marketplaceJson = {
    $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
    name: "kspec-plugins",
    description: "kspec agent skills for Claude Code",
    owner: { name: "kynetic-ai" },
    plugins: [
      {
        name: "kspec",
        description: "kspec agent skills",
        version,
        source: "./plugins/kspec",
        category: "development",
      },
    ],
  };
  fs.writeFileSync(
    path.join(pluginMetaDir, "marketplace.json"),
    JSON.stringify(marketplaceJson, null, 2) + "\n",
    "utf-8"
  );

  // Process each skill into plugin/plugins/kspec/skills/<id>/
  // (marketplace source "./plugins/kspec" points to the plugin content directory)
  const pluginContentDir = path.join(PLUGIN_DIR, "plugins", "kspec");
  const SUPPORTING_DIRS = ["docs", "references", "scripts", "assets"];
  let count = 0;
  for (const skill of manifest.skills) {
    const skillId = skill.id;
    const skillName = skill.name || skillId;
    const skillDesc = skill.description || skillName;

    // Read source SKILL.md
    const sourceSkillDir = path.join(TEMPLATES_DIR, skillId);
    const sourcePath = path.join(sourceSkillDir, "SKILL.md");
    if (!fs.existsSync(sourcePath)) {
      console.warn(`Warning: ${sourcePath} not found, skipping ${skillId}`);
      continue;
    }

    const sourceContent = fs.readFileSync(sourcePath, "utf-8");

    // Generate YAML frontmatter
    const frontmatter = yaml.stringify({ name: skillId, description: skillDesc }).trim();
    const output = `---\n${frontmatter}\n---\n<!-- kspec-managed -->\n${sourceContent}`;

    // Write to plugin/plugins/kspec/skills/<id>/SKILL.md
    const targetDir = path.join(pluginContentDir, "skills", skillId);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "SKILL.md"), output, "utf-8");

    // Copy supporting directories (docs/, references/, etc.)
    for (const dirName of SUPPORTING_DIRS) {
      const srcSubDir = path.join(sourceSkillDir, dirName);
      if (!fs.existsSync(srcSubDir)) continue;
      const destSubDir = path.join(targetDir, dirName);
      fs.mkdirSync(destSubDir, { recursive: true });
      const entries = fs.readdirSync(srcSubDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          fs.copyFileSync(
            path.join(srcSubDir, entry.name),
            path.join(destSubDir, entry.name)
          );
        }
      }
    }

    count++;
  }

  console.log(`build-plugin: ${count} skill(s), version ${version}`);
}

main();
