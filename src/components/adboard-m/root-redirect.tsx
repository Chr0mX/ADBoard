"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { MOBILE_HOME } from "@/components/adboard-m/routes";

/** /m has no screen of its own: it goes to /m/control. (A static export cannot redirect on the server.) */
export function MobileRootRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace(MOBILE_HOME);
  }, [router]);
  return null;
}
