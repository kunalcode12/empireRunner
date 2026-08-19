import type { Metadata, Viewport } from "next";
import { fontVariables } from "@/ui/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "AXIS",
  description:
    "An endless runner inside a four-face tunnel. Three lanes per face, twelve positions, " +
    "and a roll that turns any wall into your floor.",
};

export const viewport: Viewport = {
  // Matches the key-line black every theme grounds on. Keeps the browser chrome
  // from flashing white on load.
  themeColor: "#0b0b0c",
  // The game reads at speed and relies on precise touch gestures; a pinch-zoom
  // mid-run is never intentional. See docs/GAME_BIBLE.md §6.2.
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Lets the page paint into the notch and the home-indicator strip, which is
  // what makes `env(safe-area-inset-*)` return anything but zero. Without this
  // the HUD is inset by the browser instead of by us, and the corners the ring
  // and the pause chip live in are the ones a phone eats.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full ${fontVariables}`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
