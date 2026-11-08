import { MobileApp } from "@/components/adboard-m/mobile-app";
import { PrefsGate } from "@/components/adboard/prefs-gate";
import { SignInGate } from "@/components/adboard/sign-in-gate";

export default function MobileHome() {
  return (
    <SignInGate>
      <PrefsGate>
        <MobileApp />
      </PrefsGate>
    </SignInGate>
  );
}
