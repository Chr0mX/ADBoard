import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LIBRARY_FORMAT,
  exportLibraryFile,
  exportShellScript,
  macroFileName,
  mergeLibrary,
  mergeShellLibrary,
  parseLibraryFile,
  parseShellImport,
  safeFileStem,
  shellFileName,
  uniqueName,
} from "./adboard-files.ts";
import type { DeskLibrary, SavedMacro } from "./desk/store.ts";
import type { MacroTab } from "./macro/core.ts";

const emptyDesk = (): DeskLibrary => ({ apps: [], macros: [], variables: {}, deviceVariables: {}, tags: {}, groups: [], profiles: {}, history: [] });
const job = (id: string, name: string): SavedMacro => ({ id, name, folder: "Custom", steps: [{ id: `${id}-s`, kind: "wait", ms: 100 }] });
const tab = (id: string, name: string) => ({ id, name, steps: [] }) as unknown as MacroTab;
let n = 0;
const makeId = (prefix: string) => `${prefix}-new${(n += 1)}`;

describe("file names", () => {
  it("matches the agent's safe_file_stem", () => {
    assert.equal(safeFileStem("Daily:Login?"), "Daily_Login_");
    assert.equal(safeFileStem("Daily Device Setup"), "Daily_Device_Setup");
    assert.equal(safeFileStem("  "), "Untitled");
    assert.equal(safeFileStem("???", "Untitled macro"), "Untitled_macro");
    assert.equal(safeFileStem("CON"), "CON_");
    assert.equal(safeFileStem("com1.txt"), "com1.txt_");
    assert.equal(safeFileStem("trailing..."), "trailing");
    assert.equal(safeFileStem("a".repeat(120)).length, 80);
    assert.equal(safeFileStem("a\\b/c|d*e<f>g\"h"), "a_b_c_d_e_f_g_h");
  });

  it("gives ADBoard extensions", () => {
    assert.equal(macroFileName("Launch Game"), "Launch_Game.adboard-macro.json");
    assert.equal(shellFileName("Daily Login"), "Daily_Login.adboard-shell.json");
    assert.equal(macroFileName(""), "Untitled_macro.adboard-macro.json");
    assert.equal(shellFileName(""), "Untitled_script.adboard-shell.json");
  });

  it("suffixes duplicate display names case-insensitively", () => {
    assert.equal(uniqueName("Daily Login", ["daily login"]), "Daily Login 2");
    assert.equal(uniqueName("Daily Login", ["Daily Login", "Daily Login 2"]), "Daily Login 3");
    assert.equal(uniqueName("", [], "Untitled script"), "Untitled script");
    assert.equal(uniqueName("New", ["Other"]), "New");
  });
});

describe("Shell script files", () => {
  it("round-trips one script with an ADBoard header", () => {
    const text = exportShellScript(job("j1", "Daily Login"), new Date("2026-10-17T00:00:00Z"));
    const file = JSON.parse(text);
    assert.equal(file.format, "adboard-shell-script");
    assert.equal(file.app, "ADBoard");
    assert.equal(file.version, 1);
    const read = parseShellImport(text);
    assert.equal(read.kind, "scripts");
    assert.deepEqual(read.kind === "scripts" && read.scripts[0], job("j1", "Daily Login"));
  });

  it("reads the older desk export and raw job files", () => {
    const desk = parseShellImport(JSON.stringify({ apps: [], macros: [job("j1", "Old")] }));
    assert.equal(desk.kind, "library");
    assert.equal(desk.source, "desk");
    const raw = parseShellImport(JSON.stringify(job("j2", "Raw job")));
    assert.equal(raw.kind, "scripts");
    assert.equal(raw.source, "job");
  });

  it("explains the wrong or broken files", () => {
    assert.throws(() => parseShellImport(""), /empty/);
    assert.throws(() => parseShellImport("{"), /not valid JSON/);
    assert.throws(() => parseShellImport(JSON.stringify({ format: "adboard-macros", version: 1, tabs: [] })), /touch macro file/);
    assert.throws(() => parseShellImport(JSON.stringify({ format: "adboard-shell-script", version: 9, script: job("j", "x") })), /newer ADBoard/);
    assert.throws(() => parseShellImport(JSON.stringify({ hello: 1 })), /Not a Shell Automation file/);
  });
});

describe("library file", () => {
  const parts = () => ({
    touchMacros: { version: 1 as const, tabs: [tab("t1", "Launch Game")], activeId: "t1" },
    shellLibrary: { ...emptyDesk(), macros: [job("j1", "Daily Login")], variables: { server: "eu" } },
    automation: {
      queue: [{ id: "q1", tabId: "t1" }],
      schedules: [{ id: "s1", target: { kind: "tab" as const, tabId: "t1" }, kind: "once" as const, at: 1, everyMinutes: 0, enabled: true }],
      assignments: { s24: "t1" },
    },
  });

  it("exports everything under one ADBoard header", () => {
    const text = exportLibraryFile(parts(), new Date("2026-10-17T00:00:00Z"));
    const file = parseLibraryFile(text);
    assert.equal(file.format, LIBRARY_FORMAT);
    assert.equal(file.app, "ADBoard");
    assert.equal(file.touchMacros.tabs[0].name, "Launch Game");
    assert.equal(file.shellLibrary.macros[0].name, "Daily Login");
    assert.deepEqual(file.automation.assignments, { s24: "t1" });
    assert.doesNotMatch(text, /phonecontrol|rasiel/i);
  });

  it("re-importing the same file adds nothing", () => {
    const file = parseLibraryFile(exportLibraryFile(parts()));
    const merged = mergeLibrary(parts(), file, makeId);
    assert.equal(merged.touchMacros.tabs.length, 1);
    assert.equal(merged.shellLibrary.macros.length, 1);
    assert.equal(merged.automation.queue.length, 1);
    assert.equal(merged.count.touchMacros.skipped, 1);
    assert.equal(merged.count.shellScripts.skipped, 1);
  });

  it("merges into another library, renaming clashes and following new ids", () => {
    const current = {
      touchMacros: { version: 1 as const, tabs: [tab("t1", "Other macro"), tab("t9", "Launch Game")], activeId: "t1" },
      shellLibrary: { ...emptyDesk(), macros: [job("j9", "Daily Login")], variables: { server: "us" } },
      automation: { queue: [], schedules: [], assignments: {} },
    };
    const merged = mergeLibrary(current, parseLibraryFile(exportLibraryFile(parts())), makeId);
    const added = merged.touchMacros.tabs[2];
    assert.notEqual(added.id, "t1"); // id clash with different contents → fresh id
    assert.equal(added.name, "Launch Game 2");
    assert.equal(merged.automation.queue[0].tabId, added.id);
    assert.deepEqual(merged.automation.schedules[0].target, { kind: "tab", tabId: added.id });
    assert.equal(merged.automation.assignments.s24, added.id);
    assert.deepEqual(merged.shellLibrary.macros.map((m) => m.name), ["Daily Login", "Daily Login 2"]);
    assert.equal(merged.shellLibrary.variables.server, "us"); // existing values are kept
  });

  it("merges an old desk export without losing current scripts", () => {
    const current = { ...emptyDesk(), macros: [job("j1", "Keep me")] };
    const { library, scripts } = mergeShellLibrary(current, { macros: [job("j2", "Imported")] }, makeId);
    assert.deepEqual(library.macros.map((m) => m.name), ["Keep me", "Imported"]);
    assert.equal(scripts.added, 1);
  });

  it("rejects files that are not library files", () => {
    assert.throws(() => parseLibraryFile(JSON.stringify({ macros: [] })), /Not an ADBoard library file/);
  });
});
