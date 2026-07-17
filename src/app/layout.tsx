import type { Metadata, Viewport } from "next";
import { getProductSurfaceSpec } from "@/config/product-surface";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker-registration";
import { getRuntimeConfig } from "@/server/env";
import "@/styles/theme.css";
import "@/styles/product.css";

export function generateMetadata(): Metadata {
  const surface = getRuntimeConfig().productSurface;
  const spec = getProductSurfaceSpec(surface);

  return {
    title: {
      default: spec.productName,
      template: `%s · ${spec.productName}`,
    },
    robots: "noindex, nofollow, noarchive",
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [
        {
          url: `/icons/${surface}-favicon.ico`,
          type: "image/x-icon",
        },
      ],
      apple: [
        {
          url: `/icons/${surface}-apple-touch-icon.png`,
          sizes: "180x180",
          type: "image/png",
        },
      ],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
  themeColor: "#0B172A",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ms">
      <body>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
