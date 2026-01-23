/**
 * Tests for file type detection in merge driver.
 */

import { describe, expect, it } from "vitest";
import { detectFileType, FileType } from "../src/merge/file-type.js";

describe("detectFileType", () => {
  it("should detect task files (*.tasks.yaml)", () => {
    // AC: @merge-file-detection ac-1
    expect(detectFileType("project.tasks.yaml")).toBe(FileType.Tasks);
    expect(detectFileType("kynetic.tasks.yaml")).toBe(FileType.Tasks);
    expect(detectFileType(".kspec/project.tasks.yaml")).toBe(FileType.Tasks);
    expect(detectFileType("/absolute/path/to/my.tasks.yaml")).toBe(
      FileType.Tasks,
    );
  });

  it("should detect inbox files (*.inbox.yaml)", () => {
    // AC: @merge-file-detection ac-2
    expect(detectFileType("project.inbox.yaml")).toBe(FileType.Inbox);
    expect(detectFileType(".kspec/project.inbox.yaml")).toBe(FileType.Inbox);
    expect(detectFileType("/absolute/path/to/my.inbox.yaml")).toBe(
      FileType.Inbox,
    );
  });

  it("should detect spec module files (modules/*.yaml)", () => {
    // AC: @merge-file-detection ac-3
    expect(detectFileType("modules/core.yaml")).toBe(FileType.SpecModules);
    expect(detectFileType(".kspec/modules/tasks.yaml")).toBe(
      FileType.SpecModules,
    );
    expect(detectFileType("/absolute/path/modules/feature.yaml")).toBe(
      FileType.SpecModules,
    );
    expect(detectFileType("nested/path/modules/spec.yaml")).toBe(
      FileType.SpecModules,
    );
  });

  it("should detect manifest file (kynetic.yaml)", () => {
    // AC: @merge-file-detection ac-4
    expect(detectFileType("kynetic.yaml")).toBe(FileType.Manifest);
    expect(detectFileType(".kspec/kynetic.yaml")).toBe(FileType.Manifest);
    expect(detectFileType("/absolute/path/to/kynetic.yaml")).toBe(
      FileType.Manifest,
    );
  });

  it("should detect meta file (kynetic.meta.yaml)", () => {
    // AC: @merge-file-detection ac-5
    expect(detectFileType("kynetic.meta.yaml")).toBe(FileType.Meta);
    expect(detectFileType(".kspec/kynetic.meta.yaml")).toBe(FileType.Meta);
    expect(detectFileType("/absolute/path/to/kynetic.meta.yaml")).toBe(
      FileType.Meta,
    );
  });

  it("should detect unknown files and return Unknown", () => {
    // AC: @merge-file-detection ac-6
    expect(detectFileType("README.md")).toBe(FileType.Unknown);
    expect(detectFileType("config.json")).toBe(FileType.Unknown);
    expect(detectFileType("random.yaml")).toBe(FileType.Unknown);
    expect(detectFileType(".gitignore")).toBe(FileType.Unknown);
    expect(detectFileType("src/index.ts")).toBe(FileType.Unknown);
  });

  it("should handle Windows-style paths", () => {
    // Cross-platform compatibility
    expect(detectFileType("C:\\path\\to\\project.tasks.yaml")).toBe(
      FileType.Tasks,
    );
    expect(detectFileType("C:\\path\\modules\\core.yaml")).toBe(
      FileType.SpecModules,
    );
    expect(detectFileType("D:\\kspec\\kynetic.yaml")).toBe(FileType.Manifest);
  });

  it("should not confuse similar patterns", () => {
    // Edge cases - files that might look similar but aren't matches
    expect(detectFileType("tasks.yaml")).toBe(FileType.Unknown); // Missing dot before tasks
    expect(detectFileType("project.tasks.yml")).toBe(FileType.Unknown); // Wrong extension
    expect(detectFileType("kynetic.tasks.yaml.bak")).toBe(FileType.Unknown); // Has extra extension
    expect(detectFileType("modules.yaml")).toBe(FileType.Unknown); // Not in modules/ directory
  });
});
