// Obsidian's own lint rules, with the community plugin review's severities: the rules the review treats
// as errors fail the lint; every other rule is reported as a warning, as the review reports it.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

const REVIEW_ERRORS = new Set([
  "no-eval", "no-implied-eval", "@typescript-eslint/no-implied-eval", "no-new-func",
  "no-unsanitized/method", "no-unsanitized/property",
  "obsidianmd/regex-lookbehind", "obsidianmd/no-forbidden-elements",
  "eslint-comments/no-unlimited-disable", "eslint-comments/require-description",
  "eslint-comments/disable-enable-pair", "eslint-comments/no-restricted-disable",
  "obsidianmd/settings-tab/no-manual-html-headings", "obsidianmd/settings-tab/no-problematic-settings-headings",
  "obsidianmd/sample-names", "obsidianmd/no-sample-code", "obsidianmd/platform", "obsidianmd/no-plugin-as-component",
  "obsidianmd/detach-leaves", "obsidianmd/no-static-styles-assignment", "obsidianmd/no-view-references-in-plugin",
  "obsidianmd/no-unsupported-api",
]);

const isOn = (v) => !["off", 0].includes(Array.isArray(v) ? v[0] : v);
const asReview = (config) =>
  config.rules
    ? {
        ...config,
        rules: Object.fromEntries(
          Object.entries(config.rules).map(([rule, v]) => {
            if (!isOn(v) || REVIEW_ERRORS.has(rule)) return [rule, v];
            return [rule, Array.isArray(v) ? ["warn", ...v.slice(1)] : "warn"];
          }),
        ),
      }
    : config;

export default defineConfig([
  // Build output and Node build scripts are not plugin code.
  globalIgnores(["node_modules", "dist", "main.js", "test/.out.js", "esbuild.config.mjs", "version-bump.mjs", "CLAUDE-SECURITY-*", ".superpowers", "docs", "test-vault"]),
  ...obsidianmd.configs.recommended.map(asReview),
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.mjs", "test/*.ts"] },
      },
    },
  },
]);
