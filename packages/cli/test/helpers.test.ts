import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  formatBytes,
  formatValue,
  getApiKeysPath,
  loadApiKeys,
  saveApiKeys,
  ensureDataDir,
  calculateColumnWidths,
  formatTableRow,
  listProjects,
  projectExists,
  getProjectKeyCount,
  ApiKeyConfig,
} from "../src/helpers";

describe("CLI Helpers", () => {
  const testDir = path.join(process.cwd(), "test-cli-data");

  beforeEach(() => {
    // Create test directory
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe("formatBytes", () => {
    it("formats 0 bytes", () => {
      expect(formatBytes(0)).toBe("0 B");
    });

    it("formats bytes", () => {
      expect(formatBytes(500)).toBe("500 B");
    });

    it("formats kilobytes", () => {
      expect(formatBytes(1024)).toBe("1 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
    });

    it("formats megabytes", () => {
      expect(formatBytes(1024 * 1024)).toBe("1 MB");
      expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    });

    it("formats gigabytes", () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
    });
  });

  describe("formatValue", () => {
    it("formats null", () => {
      expect(formatValue(null)).toBe("null");
    });

    it("formats undefined", () => {
      expect(formatValue(undefined)).toBe("");
    });

    it("formats strings", () => {
      expect(formatValue("hello")).toBe("hello");
    });

    it("formats numbers", () => {
      expect(formatValue(42)).toBe("42");
      expect(formatValue(3.14)).toBe("3.14");
    });

    it("formats booleans", () => {
      expect(formatValue(true)).toBe("true");
      expect(formatValue(false)).toBe("false");
    });

    it("formats objects as JSON", () => {
      expect(formatValue({ a: 1 })).toBe('{"a":1}');
    });

    it("formats arrays as JSON", () => {
      expect(formatValue([1, 2, 3])).toBe("[1,2,3]");
    });
  });

  describe("API Key functions", () => {
    describe("getApiKeysPath", () => {
      it("returns correct path", () => {
        expect(getApiKeysPath("/data")).toBe("/data/api-keys.json");
      });
    });

    describe("loadApiKeys", () => {
      it("returns empty object when file does not exist", () => {
        expect(loadApiKeys(testDir)).toEqual({});
      });

      it("loads keys from file", () => {
        const keys = { "key-1": { project: "test", env: "production" } };
        fs.writeFileSync(
          path.join(testDir, "api-keys.json"),
          JSON.stringify(keys)
        );

        expect(loadApiKeys(testDir)).toEqual(keys);
      });

      it("returns empty object on invalid JSON", () => {
        fs.writeFileSync(path.join(testDir, "api-keys.json"), "invalid json");

        expect(loadApiKeys(testDir)).toEqual({});
      });
    });

    describe("saveApiKeys", () => {
      it("saves keys to file", () => {
        const keys = { "key-1": { project: "test", admin: true } };
        saveApiKeys(testDir, keys);

        const content = fs.readFileSync(
          path.join(testDir, "api-keys.json"),
          "utf-8"
        );
        expect(JSON.parse(content)).toEqual(keys);
      });

      it("overwrites existing file", () => {
        saveApiKeys(testDir, { "old-key": { project: "old" } });
        saveApiKeys(testDir, { "new-key": { project: "new" } });

        const loaded = loadApiKeys(testDir);
        expect(loaded).toEqual({ "new-key": { project: "new" } });
      });
    });

    describe("getProjectKeyCount", () => {
      it("returns 0 for no matching keys", () => {
        const keys = { "key-1": { project: "other" } };
        expect(getProjectKeyCount(keys, "myproject")).toBe(0);
      });

      it("counts matching keys", () => {
        const keys: Record<string, ApiKeyConfig> = {
          "key-1": { project: "myproject", env: "production" },
          "key-2": { project: "myproject", env: "test" },
          "key-3": { project: "other" },
        };
        expect(getProjectKeyCount(keys, "myproject")).toBe(2);
      });
    });
  });

  describe("ensureDataDir", () => {
    it("creates data directory if it does not exist", () => {
      const dataPath = path.join(testDir, "new-data");
      ensureDataDir(dataPath);

      expect(fs.existsSync(dataPath)).toBe(true);
      expect(fs.existsSync(path.join(dataPath, "production"))).toBe(true);
      expect(fs.existsSync(path.join(dataPath, "test"))).toBe(true);
    });

    it("creates subdirectories if they do not exist", () => {
      fs.mkdirSync(testDir, { recursive: true });
      ensureDataDir(testDir);

      expect(fs.existsSync(path.join(testDir, "production"))).toBe(true);
      expect(fs.existsSync(path.join(testDir, "test"))).toBe(true);
    });
  });

  describe("Table formatting", () => {
    describe("calculateColumnWidths", () => {
      it("calculates widths based on header", () => {
        const widths = calculateColumnWidths(["name", "age"], []);
        expect(widths.name).toBe(4);
        expect(widths.age).toBe(3);
      });

      it("calculates widths based on data", () => {
        const widths = calculateColumnWidths(
          ["name", "age"],
          [{ name: "Alexander", age: 100 }]
        );
        expect(widths.name).toBe(9);
        expect(widths.age).toBe(3); // "100" = 3 chars
      });

      it("caps max width", () => {
        const longValue = "x".repeat(100);
        const widths = calculateColumnWidths(
          ["name"],
          [{ name: longValue }],
          40
        );
        expect(widths.name).toBe(40);
      });
    });

    describe("formatTableRow", () => {
      it("formats a row with padding", () => {
        const row = formatTableRow(
          ["name", "age"],
          { name: "Alice", age: 30 },
          { name: 10, age: 5 }
        );
        expect(row).toBe("Alice      | 30   ");
      });

      it("truncates long values", () => {
        const row = formatTableRow(
          ["name"],
          { name: "VeryLongName" },
          { name: 5 }
        );
        expect(row).toBe("VeryL");
      });
    });
  });

  describe("Project functions", () => {
    describe("listProjects", () => {
      it("returns empty map when no projects exist", () => {
        ensureDataDir(testDir);
        const projects = listProjects(testDir);
        expect(projects.size).toBe(0);
      });

      it("lists projects from production directory", () => {
        ensureDataDir(testDir);
        fs.writeFileSync(path.join(testDir, "production", "proj1.db"), "");
        fs.writeFileSync(path.join(testDir, "production", "proj2.db"), "");

        const projects = listProjects(testDir);
        expect(projects.size).toBe(2);
        expect(projects.get("proj1")).toContain("production");
        expect(projects.get("proj2")).toContain("production");
      });

      it("lists projects from both environments", () => {
        ensureDataDir(testDir);
        fs.writeFileSync(path.join(testDir, "production", "myproject.db"), "");
        fs.writeFileSync(path.join(testDir, "test", "myproject.db"), "");

        const projects = listProjects(testDir);
        expect(projects.size).toBe(1);
        expect(projects.get("myproject")).toContain("production");
        expect(projects.get("myproject")).toContain("test");
      });

      it("ignores non-db files", () => {
        ensureDataDir(testDir);
        fs.writeFileSync(path.join(testDir, "production", "project.db"), "");
        fs.writeFileSync(path.join(testDir, "production", "readme.txt"), "");

        const projects = listProjects(testDir);
        expect(projects.size).toBe(1);
      });
    });

    describe("projectExists", () => {
      beforeEach(() => {
        ensureDataDir(testDir);
      });

      it("returns false when project does not exist", () => {
        expect(projectExists(testDir, "nonexistent")).toBe(false);
      });

      it("returns true when project exists in production", () => {
        fs.writeFileSync(path.join(testDir, "production", "myproject.db"), "");
        expect(projectExists(testDir, "myproject")).toBe(true);
      });

      it("returns true when project exists in test", () => {
        fs.writeFileSync(path.join(testDir, "test", "myproject.db"), "");
        expect(projectExists(testDir, "myproject")).toBe(true);
      });

      it("checks specific environment", () => {
        fs.writeFileSync(path.join(testDir, "production", "myproject.db"), "");

        expect(projectExists(testDir, "myproject", "production")).toBe(true);
        expect(projectExists(testDir, "myproject", "test")).toBe(false);
      });
    });
  });
});
