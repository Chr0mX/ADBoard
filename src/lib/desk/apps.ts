/*
 * Saved apps: reading the phone's package list, categories and duplicates.
 * Pure functions (no React, no browser APIs), so they run under `node --test`.
 */
import type { AppShortcut } from "./store.ts";

/** Categories that are always listed, in this order. */
export const BUILT_IN_CATEGORIES = ["Games", "Media", "Tools", "Custom"] as const;
export const DEFAULT_CATEGORY = "Custom";
const MAX_CATEGORY = 40;

/** `package:com.example.app` lines from `pm list packages` → sorted package ids, no repeats. */
export function parsePackages(output: string | undefined | null): string[] {
  const found = new Set<string>();
  for (const line of (output ?? "").split(/\r?\n/)) {
    const id = line.replace(/^package:/, "").trim();
    if (/^[A-Za-z0-9_.]+$/.test(id)) found.add(id);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

/** The name to show for an app whose real name isn't known: the last part of its package id. */
export function nameFromPackage(packageName: string): string {
  return packageName.split(".").filter(Boolean).pop() || packageName;
}

/**
 * Tidy a category name typed by the user. Spaces are trimmed and collapsed; a
 * name that matches an existing category (in any letter case) reuses that
 * one's spelling; an empty name is "Custom".
 */
export function normalizeCategory(input: string, existing: readonly string[]): string {
  const name = input.replace(/\s+/g, " ").trim().slice(0, MAX_CATEGORY).trim();
  if (!name) return DEFAULT_CATEGORY;
  return existing.find((c) => c.toLowerCase() === name.toLowerCase()) ?? name;
}

/** Built-in categories first, then each custom one in the order apps were added. */
export function categoriesOf(apps: readonly Pick<AppShortcut, "group">[]): string[] {
  const names: string[] = [...BUILT_IN_CATEGORIES];
  for (const app of apps) {
    const group = (app.group || DEFAULT_CATEGORY).trim();
    if (group && !names.some((n) => n.toLowerCase() === group.toLowerCase())) names.push(group);
  }
  return names;
}

/** The saved app with this package id (other than `exceptId`), if any. */
export function findDuplicate(apps: readonly AppShortcut[], packageName: string, exceptId?: string): AppShortcut | undefined {
  const wanted = packageName.trim();
  return apps.find((app) => app.id !== exceptId && app.packageName.trim() === wanted);
}

/** Message for a refused duplicate, naming where the app already is. */
export function duplicateMessage(app: AppShortcut): string {
  return `Already saved as “${app.name}” in ${app.group || DEFAULT_CATEGORY}.`;
}

/** Filter scanned packages by a search typed in the box (package id or known name). */
export function matchesSearch(packageName: string, label: string | null | undefined, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return packageName.toLowerCase().includes(q) || (label ?? "").toLowerCase().includes(q);
}
