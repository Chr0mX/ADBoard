import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // `next build` for the Windows pack. `next dev` stays a normal server.
  ...(process.env.ADBOARD_STATIC_EXPORT === "1"
    ? { output: "export" as const }
    : {}),
};

export default nextConfig;
