import { MORE_SECTION_IDS } from "@/components/adboard-m/routes";

/** One static page per section (a static export needs the list). The shell draws it. */
export const dynamicParams = false;

export function generateStaticParams() {
  return MORE_SECTION_IDS.map((section) => ({ section }));
}

export default function Page() {
  return null;
}
