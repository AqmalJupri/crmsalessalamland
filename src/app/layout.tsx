import type { Metadata, Viewport } from "next";
import "@/styles/theme.css";
import "@/styles/product.css";

export const metadata: Metadata = {
  title: { default: "Salam CRM", template: "%s · Salam CRM" },
  description: "CRM dan revenue operations Salam",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
  themeColor: "#0B172A",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ms">
      <body>{children}</body>
    </html>
  );
}
