"use client";

import {
  LIBRARY_FILE,
  exportLibraryFile,
  mergeLibrary,
  parseLibraryFile,
  type Automation,
  type MergeCount,
  type TouchMacros,
} from "@/lib/adboard-files";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";
import { saveTextFile } from "@/lib/api/download";
import { deskReady, getLibrary, newId, parseDeskExport, saveLibrary, type DeskLibrary } from "@/lib/desk/store";
import { assignmentsReady, getAssignments, normalizeAssignments, setAssignments } from "@/lib/macro/assignments";
import { normalizeQueue, normalizeSchedules } from "@/lib/macro/automation";
import { automationReady, getAutomation, setAutomation } from "@/lib/macro/automation-store";
import { getWorkspace, macrosReady, normalizeWorkspace, replaceWorkspace } from "@/lib/macro/store";

/*
 * Whole-library export and import (adboard-library.json): touch macros, Shell
 * Automation (scripts, apps, variables, groups, profiles), the macro queue,
 * schedules and per-phone macro choices — everything the stores hold.
 */

/**
 * The stores load from the agent the first time they are read; a page that
 * hasn't shown Macros or Shell Automation yet must wait for that, or it would
 * export (or merge into) an empty starter library.
 */
function loaded(): Promise<void> {
  return Promise.all([macrosReady(), deskReady(), automationReady(), assignmentsReady()]).then(() => undefined);
}

function current(): { touchMacros: TouchMacros; shellLibrary: DeskLibrary; automation: Automation } {
  const automation = getAutomation();
  return {
    touchMacros: getWorkspace(),
    shellLibrary: getLibrary(),
    automation: { queue: automation.queue, schedules: automation.schedules, assignments: getAssignments() },
  };
}

export async function exportWholeLibrary(): Promise<boolean> {
  await loaded();
  return saveTextFile(exportLibraryFile(current()), LIBRARY_FILE);
}

/** Ask the agent to copy the data folder to backups\backup-<date>\ first. Null without an agent. */
export async function backupNow(): Promise<string | null> {
  const base = agentBaseUrl();
  if (base === null) return null;
  const res = await agentFetch(`${base}/api/system/backup`, { method: "POST" });
  if (!res.ok) throw new Error(`Backup failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { path?: string };
  return body.path ?? "";
}

export interface LibraryImportResult {
  touchMacros: MergeCount;
  shellScripts: MergeCount;
  backup: string | null;
}

/**
 * Import adboard-library.json. "merge" (default) adds what is new, renames
 * name clashes and skips items already here; "replace" swaps everything.
 * Either way the agent backs up the current data first, and the file is
 * fully checked before anything changes.
 */
export async function importWholeLibrary(text: string, mode: "merge" | "replace"): Promise<LibraryImportResult> {
  const file = parseLibraryFile(text);
  // Validate every part first (throws with a readable reason; nothing changes).
  const tabs = file.touchMacros.tabs.length > 0 ? normalizeWorkspace(file.touchMacros).tabs : [];
  const incoming = {
    ...file,
    touchMacros: { version: 1 as const, tabs, activeId: file.touchMacros.activeId },
    shellLibrary: parseDeskExport(JSON.stringify(file.shellLibrary)),
    automation: {
      queue: normalizeQueue(file.automation.queue),
      schedules: normalizeSchedules(file.automation.schedules),
      assignments: normalizeAssignments(file.automation.assignments),
    },
  };
  await loaded();
  const backup = await backupNow();
  const none: MergeCount = { added: 0, renamed: 0, skipped: 0 };
  if (mode === "replace") {
    if (tabs.length > 0) replaceWorkspace(incoming.touchMacros);
    saveLibrary(incoming.shellLibrary);
    setAutomation(incoming.automation);
    setAssignments(incoming.automation.assignments);
    return {
      touchMacros: { ...none, added: tabs.length },
      shellScripts: { ...none, added: incoming.shellLibrary.macros.length },
      backup,
    };
  }
  const merged = mergeLibrary(current(), incoming, newId);
  replaceWorkspace(merged.touchMacros);
  saveLibrary(merged.shellLibrary);
  setAutomation(merged.automation);
  setAssignments(merged.automation.assignments);
  return { ...merged.count, backup };
}

export function describeImport(result: LibraryImportResult): string {
  const part = (label: string, c: MergeCount) =>
    `${label}: ${c.added} added${c.renamed ? ` (${c.renamed} renamed to avoid a duplicate name)` : ""}${c.skipped ? `, ${c.skipped} already here` : ""}`;
  const backup = result.backup ? ` Backup of the previous data: ${result.backup}` : "";
  return `${part("Touch macros", result.touchMacros)}. ${part("Shell scripts", result.shellScripts)}.${backup}`;
}
