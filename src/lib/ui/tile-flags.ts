/**
 * What a grid tile shows about its phone's place in the control group, as
 * plain booleans. Memoised tiles compare these, so a change to another phone
 * leaves a tile's props equal and it is not rendered again.
 *
 * Pure module: runs under `node --test`.
 */
export interface TileGroupState {
  activeId: string | null;
  /** Multi or All mode: one touch goes to several phones. */
  groupMode: boolean;
  /** Ids of the phones that receive a group touch. */
  targetIds: ReadonlySet<string>;
  controlMode: "selected" | "multi" | "all";
  selectedIds?: ReadonlySet<string>;
}

export interface TileFlags {
  isActive: boolean;
  inTargets: boolean;
  included: boolean;
}

export function tileFlags(device: { id: string; status: string }, state: TileGroupState): TileFlags {
  return {
    isActive: device.id === state.activeId,
    inTargets: state.groupMode && state.targetIds.has(device.id),
    included:
      device.status === "online" &&
      (state.controlMode === "all" ? true : (state.selectedIds?.has(device.id) ?? false)),
  };
}

/** Two session reports that show the same thing. */
export function sameSession(
  a: { stream: string; note: string; backend: string } | undefined,
  b: { stream: string; note: string; backend: string },
): boolean {
  return a !== undefined && a.stream === b.stream && a.note === b.note && a.backend === b.backend;
}
