import type { Metadata } from "next";
import { ADBoardApp } from "@/components/adboard/adboard-app";
import { PrefsGate } from "@/components/adboard/prefs-gate";
import { SignInGate } from "@/components/adboard/sign-in-gate";
import { DeviceHint } from "@/components/pwa/device-hint";
import { RegisterSw } from "@/components/pwa/register-sw";

/** The desktop app: its own manifest (id and scope "/") and service worker. */
export const metadata: Metadata = {
  manifest: "/manifest.webmanifest",
};

export default function Home() {
  return (
    <SignInGate>
      <PrefsGate>
        <ADBoardApp />
      </PrefsGate>
      <DeviceHint />
      <RegisterSw script="/sw.js" scope="/" />
    </SignInGate>
  );
}
