import type { MetadataRoute } from "next";
import {
  getProductSurfaceFromEnvironment,
  getProductSurfaceSpec,
} from "@/config/product-surface";

export default function manifest(): MetadataRoute.Manifest {
  const surface = getProductSurfaceFromEnvironment();
  const spec = getProductSurfaceSpec(surface);

  return {
    name: spec.productName,
    short_name: spec.productName,
    lang: "ms",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#F8FAFC",
    theme_color: "#0B172A",
    icons: [
      {
        src: `/icons/${surface}-192.png`,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `/icons/${surface}-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `/icons/${surface}-maskable-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
