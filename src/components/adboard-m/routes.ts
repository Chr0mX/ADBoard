/**
 * Paths of the mobile app. Pure (no React, no "use client") so route files can
 * use it for generateStaticParams and tests can run it.
 *
 *   /m/control        Control (full-screen phone)
 *   /m/devices        Control with the Phones sheet open
 *   /m/macros         Macros
 *   /m/more           the list of the other sections
 *   /m/more/<id>      one of those sections
 */
export const MORE_SECTION_IDS = ["manage", "apps", "files", "automate", "developer", "hosts", "events", "storage", "settings"] as const;
export type MoreSectionId = (typeof MORE_SECTION_IDS)[number];

export type MobileRoute =
  | { view: "root" }
  | { view: "control" }
  | { view: "devices" }
  | { view: "macros" }
  | { view: "more" }
  | { view: "section"; section: MoreSectionId };

export const MOBILE_HOME = "/m/control/";

export function isMoreSection(value: string): value is MoreSectionId {
  return (MORE_SECTION_IDS as readonly string[]).includes(value);
}

/** Works with and without a trailing slash (static export serves "/m/control/"). */
export function parseMobilePath(pathname: string | null | undefined): MobileRoute {
  const parts = (pathname ?? "").split("/").filter(Boolean);
  if (parts[0] !== "m" || parts.length === 1) return { view: "root" };
  switch (parts[1]) {
    case "control":
      return { view: "control" };
    case "devices":
      return { view: "devices" };
    case "macros":
      return { view: "macros" };
    case "more":
      return parts[2] && isMoreSection(parts[2]) ? { view: "section", section: parts[2] } : { view: "more" };
    default:
      return { view: "root" };
  }
}

/** Where a desk section lives in the mobile app. */
export function pathForSection(section: string): string {
  if (section === "control") return "/m/control/";
  if (section === "macros") return "/m/macros/";
  return isMoreSection(section) ? `/m/more/${section}/` : "/m/more/";
}

/** The desk section a route shows (null for the Phones sheet and the More list). */
export function sectionOfRoute(route: MobileRoute): string | null {
  switch (route.view) {
    case "control":
    case "devices":
      return "control";
    case "macros":
      return "macros";
    case "section":
      return route.section;
    default:
      return null;
  }
}
