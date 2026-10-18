import { ADBoardApp } from "@/components/adboard/adboard-app";
import { PrefsGate } from "@/components/adboard/prefs-gate";
import { SignInGate } from "@/components/adboard/sign-in-gate";

export default function Home() {
  return (
    <SignInGate>
      <PrefsGate>
        <ADBoardApp />
      </PrefsGate>
    </SignInGate>
  );
}
