import { PhoneControlApp } from "@/components/phone-control/phone-control-app";
import { SignInGate } from "@/components/phone-control/sign-in-gate";

export default function Home() {
  return (
    <SignInGate>
      <PhoneControlApp />
    </SignInGate>
  );
}
