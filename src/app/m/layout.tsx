import type { Metadata, Viewport } from "next";
import { MobileApp } from "@/components/adboard-m/mobile-app";
import { PrefsGate } from "@/components/adboard/prefs-gate";
import { SignInGate } from "@/components/adboard/sign-in-gate";
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

/**
 * Edge to edge on iPhone (the shell pads the safe areas itself). Unlike the
 * desktop root, fields here are small (13 px), so maximum-scale=1 stops iOS
 * zooming in on focus. iPhone Safari ignores it for pinch-zoom, which still works.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0e141b",
};

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* One shell for every /m route: it keeps the phone state and video while the path changes. */}
      <SignInGate>
        <PrefsGate>
          <MobileApp>{children}</MobileApp>
        </PrefsGate>
      </SignInGate>
      <RegisterSw script="/m/sw.js" scope="/m/" />
    </>
  );
}
