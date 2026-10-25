// src/__tests__/skill-files.test.ts
// Real-filesystem tests for skill:// URIs and listFiles / readFile.

import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SkillRouter,
  formatSkillUri,
  parseSkillUri,
  resolveSkillFilePath,
  skillRootDir,
} from "../skill-router.js";

function tempSkill(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lg-skill-files-"));
  writeFileSync(join(dir, "SKILL.md"), "---\nname: demo\n---\n");
  writeFileSync(join(dir, "INSTRUCTIONS.md"), "Do the demo.\n");
  for (const [rel, body] of Object.entries(extra)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

describe("skill URI helpers", () => {
  it("formats and parses skill:// URIs", () => {
    expect(formatSkillUri("docx", "scripts/run.sh")).toBe("skill://docx/scripts/run.sh");
    expect(parseSkillUri("skill://docx/scripts/run.sh")).toEqual({
      name: "docx",
      relPath: "scripts/run.sh",
    });
    expect(parseSkillUri("skill://docx/")).toEqual({ name: "docx", relPath: "" });
    expect(parseSkillUri("https://example.com/x")).toBeNull();
  });

  it("rejects path escape in resolveSkillFilePath", () => {
    const root = "/tmp/skill-root";
    expect(() => resolveSkillFilePath(root, "../etc/passwd")).toThrow(/Invalid|escapes/);
    expect(() => resolveSkillFilePath(root, "a/../../b")).toThrow(/Invalid|escapes/);
  });
});

describe("SkillRouter.listFiles / readFile", () => {
  it("lists bundled files and reads them", () => {
    const dir = tempSkill({
      "scripts/helper.py": "print('hi')\n",
      "references/notes.md": "# notes\n",
    });
    const router = new SkillRouter({
      demo: { description: "Demo", keywords: ["demo"], path: join(dir, "SKILL.md") },
    });
    expect(skillRootDir(router.getConfig("demo")!)).toBe(dir);
    const files = router.listFiles("demo");
    expect(files).toEqual(
      expect.arrayContaining(["INSTRUCTIONS.md", "SKILL.md", "scripts/helper.py", "references/notes.md"])
    );

    const py = router.readFile("demo", "scripts/helper.py");
    expect(py.text).toContain("print('hi')");
    expect(py.mimeType).toBe("text/plain");

    const viaUri = parseSkillUri(formatSkillUri("demo", "references/notes.md"))!;
    const notes = router.readFile(viaUri.name, viaUri.relPath);
    expect(notes.text).toContain("# notes");
  });

  it("rejects traversal and missing files", () => {
    const dir = tempSkill();
    const router = new SkillRouter({
      demo: { description: "Demo", keywords: ["demo"], path: join(dir, "SKILL.md") },
    });
    expect(() => router.readFile("demo", "../outside")).toThrow();
    expect(() => router.readFile("demo", "nope.txt")).toThrow(/not found/i);
    expect(() => router.listFiles("ghost")).toThrow(/Unknown skill/);
  });
});
