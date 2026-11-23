import type { Metadata, Viewport } from "next";
import {
  Geist,
  Figtree,
  JetBrains_Mono,
  Fira_Code,
  Source_Code_Pro,
  IBM_Plex_Mono,
  Roboto_Mono,
  Ubuntu_Mono,
  Space_Mono,
  Inconsolata,
  Anonymous_Pro,
  DM_Mono,
  Red_Hat_Mono,
} from "next/font/google";
import { MonoFontSync } from "@/components/adboard/mono-font-sync";
import { ThemeSync } from "@/components/adboard/theme-sync";
import { VideoSettingsSync } from "@/components/adboard/video-settings-sync";
import { themeBootScript } from "@/lib/ui/themes";
import { themeCss } from "@/lib/ui/themes";
import { DEFAULT_MONO_FONT, MONO_FONT_KEY } from "@/lib/ui/mono-fonts";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geist = Geist({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700"],
});

const figtree = Figtree({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Technical values (docs/typography.md): JetBrains Mono unless the person picks another in
// Settings → Appearance. The others are declared but not preloaded, so the browser only
// downloads the one in use. Each sets its own variable; globals.css maps the choice to --font-mono.
const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const fira = Fira_Code({
  variable: "--font-fira",
  subsets: ["latin"],
  weight: ["400", "500"],
  preload: false,
});

const sourceCode = Source_Code_Pro({
  variable: "--font-source-code",
  subsets: ["latin"],
  weight: ["400", "500"],
  preload: false,
});

const plex = IBM_Plex_Mono({
  variable: "--font-plex",
  subsets: ["latin"],
  weight: ["400", "500"],
  preload: false,
});

const roboto = Roboto_Mono({
  variable: "--font-roboto",
  subsets: ["latin"],
  weight: ["400", "500"],
  preload: false,
});

const ubuntu = Ubuntu_Mono({
  variable: "--font-ubuntu",
  subsets: ["latin"],
  weight: ["400"],
  preload: false,
});

const space = Space_Mono({
  variable: "--font-space",
  subsets: ["latin"],
  weight: ["400"],
  preload: false,
});

const inconsolata = Inconsolata({
  variable: "--font-inconsolata",
  subsets: ["latin"],
  weight: ["400", "500"],
  preload: false,
});

const anonymous = Anonymous_Pro({
  variable: "--font-anonymous",
  subsets: ["latin"],
  weight: ["400"],
  preload: false,
});

const dm = DM_Mono({
  variable: "--font-dm",
  subsets: ["latin"],
  weight: ["400", "500"],
  preload: false,
});

const redHat = Red_Hat_Mono({
  variable: "--font-red-hat",
  subsets: ["latin"],
  weight: ["400", "500"],
  preload: false,
});

const MONO_CLASSES = [jetbrains, fira, sourceCode, plex, roboto, ubuntu, space, inconsolata, anonymous, dm, redHat]
  .map((font) => font.variable)
  .join(" ");

// Applies the saved choice before the first paint (the same value the Appearance setting writes).
const MONO_FONT_SCRIPT = `try{var f=localStorage.getItem(${JSON.stringify(MONO_FONT_KEY)});if(f&&/^[a-z0-9-]+$/.test(f)&&f!==${JSON.stringify(DEFAULT_MONO_FONT)})document.documentElement.dataset.monoFont=f}catch(e){}`;
export const metadata: Metadata = {
  title: "ADBoard",
  description:
    "Multi-device Android control center — scrcpy/ADB transport with a unified Web UI.",
  applicationName: "ADBoard",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ADBoard",
  },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { url: "/icons/icon.svg", type: "image/svg+xml" },
    ],
    // iOS Home Screen icon: 180×180, opaque (iOS paints transparency black).
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0e141b",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${figtree.variable} ${MONO_CLASSES} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Theme colours, then the saved choice applied before the first paint (src/lib/ui/themes.ts). */}
        <style id="adboard-themes" dangerouslySetInnerHTML={{ __html: themeCss() }} />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript() }} />
        <script dangerouslySetInnerHTML={{ __html: MONO_FONT_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col font-sans">
        <ThemeSync />
        <VideoSettingsSync />
        <MonoFontSync />
        <TooltipProvider>
          {children}
          <Toaster
            position="bottom-right"
            richColors
            closeButton
            offset={16}
            style={{ "--width": "300px" } as React.CSSProperties}
            mobileOffset={{ left: 12, right: 12, bottom: "calc(12px + env(safe-area-inset-bottom))" }}
          />
        </TooltipProvider>
      </body>
    </html>
  );
}
