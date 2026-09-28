"use client";

import { createContext, useContext } from "react";
import type { SelectionEvent } from "@/hooks/use-phone-control";
import type { Device, SessionStatus } from "@/lib/devices/types";

export const DESK_SECTIONS = [
  { id: "control", label: "Control" },
  { id: "manage", label: "Manage" },
  { id: "apps", label: "Apps" },
  { id: "files", label: "Files" },
  { id: "automate", label: "Automate" },
  { id: "developer", label: "Developer" },
  { id: "hosts", label: "Hosts" },
] as const;

export type DeskSection = (typeof DESK_SECTIONS)[number]["id"];

export function asSection(value: string | null): DeskSection {
  return DESK_SECTIONS.some((item) => item.id === value) ? (value as DeskSection) : "control";
}

export interface DeskValue {
  section: DeskSection;
  focusTool: string | null;
  devices: Device[];
  activeDevice: Device | null;
  targets: Device[];
  sessions: Map<string, SessionStatus>;
  lastSeen: Record<string, number>;
  open: (section: DeskSection, tool?: string, deviceId?: string) => void;
  selectDevice: (event: SelectionEvent) => void;
}

const DeskContext = createContext<DeskValue | null>(null);

export function DeskProvider({
  value,
  children,
}: {
  value: DeskValue;
  children: React.ReactNode;
}) {
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}

export function useDesk() {
  const value = useContext(DeskContext);
  if (!value) throw new Error("useDesk must be used inside DeskProvider");
  return value;
}

export function useDeskOptional() {
  return useContext(DeskContext);
}
