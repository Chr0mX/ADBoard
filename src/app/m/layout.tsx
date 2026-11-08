import type { Metadata } from "next";
import { RegisterSw } from "@/components/pwa/register-sw";

/**
 * ADBoard Mobile: its own app identity (manifest id and scope "/m/") and
 * service worker, so an install from here opens the phone UI and the desktop
 * worker never answers for it.
 */
export const metadata: Metadata = {
  title: "ADBoard Mobile",
  applicationName: "ADBoard Mobile",
  manifest: "/m/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "ADBoard" },
};

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <RegisterSw script="/m/sw.js" scope="/m/" />
    </>
  );
}
