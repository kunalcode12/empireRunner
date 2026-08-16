import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AXIS",
  description:
    "An endless runner inside a four-face tunnel. Three lanes per face, twelve positions, " +
    "and a roll that turns any wall into your floor.",
};

export const viewport: Viewport = {
  // Matches --axis-keyline. Keeps the browser chrome from flashing white on load.
  themeColor: "#0b0b0c",
  // The game reads at speed and relies on precise touch gestures; a pinch-zoom
  // mid-run is never intentional. See docs/GAME_BIBLE.md §6.2.
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
