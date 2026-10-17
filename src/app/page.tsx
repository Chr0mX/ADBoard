import { ADBoardApp } from "@/components/adboard/adboard-app";
import { SignInGate } from "@/components/adboard/sign-in-gate";

export default function Home() {
  return (
    <SignInGate>
      <ADBoardApp />
    </SignInGate>
  );
}
