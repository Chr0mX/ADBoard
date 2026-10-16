/** Grid view layout: automatic, or a fixed columns × rows with pages. */

export const GRID_LAYOUT_MAX = 8;

export type GridLayout = { mode: "auto" } | { mode: "fixed"; cols: number; rows: number };

const clamp = (n: number) => Math.min(GRID_LAYOUT_MAX, Math.max(1, Math.round(n)));

/** Stored as "auto" or "COLSxROWS" (e.g. "3x2"). */
export function parseGridLayout(raw: string | null | undefined): GridLayout {
  const match = /^(\d+)x(\d+)$/.exec((raw ?? "").trim());
  if (!match) return { mode: "auto" };
  return { mode: "fixed", cols: clamp(Number(match[1])), rows: clamp(Number(match[2])) };
}

export function formatGridLayout(layout: GridLayout): string {
  return layout.mode === "auto" ? "auto" : `${clamp(layout.cols)}x${clamp(layout.rows)}`;
}

export interface TilePack {
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
}

/** Largest phone-shaped tile that fits a fixed cols × rows grid. */
export function fixedPack(
  cols: number,
  rows: number,
  stageW: number,
  stageH: number,
  aspect: number,
  gap: number,
  statsH: number,
): TilePack {
  const pack = { cols, rows, tileW: 0, tileH: 0 };
  if (!(stageW > 0 && stageH > 0 && aspect > 0)) return pack;
  const cellW = (stageW - gap * (cols - 1)) / cols;
  const streamH = (stageH - gap * (rows - 1)) / rows - statsH;
  if (!(cellW > 1 && streamH > 1)) return pack;
  if (cellW / streamH > aspect) {
    pack.tileH = Math.floor(streamH);
    pack.tileW = Math.floor(streamH * aspect);
  } else {
    pack.tileW = Math.floor(cellW);
    pack.tileH = Math.floor(cellW / aspect);
  }
  return pack;
}

export function pageCount(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, perPage)));
}

/** Clamp a page index into range for the current item count. */
export function clampPage(page: number, total: number, perPage: number): number {
  return Math.min(Math.max(0, page), pageCount(total, perPage) - 1);
}

export function pageSlice<T>(items: readonly T[], page: number, perPage: number): T[] {
  const p = clampPage(page, items.length, perPage);
  return items.slice(p * perPage, p * perPage + perPage);
}
