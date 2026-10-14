export const APP_NAME = "Rasiel";

/**
 * Browser tab title. Control names the phone being driven so several Rasiel
 * tabs stay distinguishable; other sections use their own label.
 */
export function documentTitle(options: {
  section: string;
  sectionLabel?: string;
  gridView?: boolean;
  deviceName?: string | null;
}): string {
  if (options.section !== "control") {
    return options.sectionLabel ? `${options.sectionLabel} · ${APP_NAME}` : APP_NAME;
  }
  if (options.gridView) return `Grid · ${APP_NAME}`;
  const name = options.deviceName?.trim();
  return name ? `${name} · ${APP_NAME}` : APP_NAME;
}
