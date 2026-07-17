import { SearchX } from "lucide-react";
import Link from "next/link";
import { getProductSurfaceSpec } from "@/config/product-surface";
import { getRuntimeConfig } from "@/server/env";

export const dynamic = "force-dynamic";

export default function NotFound() {
  const surface = getRuntimeConfig().productSurface;
  const surfaceSpec = getProductSurfaceSpec(surface);

  return (
    <main className="crm-theme crm-login-page">
      <section className="crm-login-card" aria-labelledby="not-found-title">
        <header className="crm-login-card__brand">
          <span className="crm-login-card__mark" aria-hidden="true">
            {surface === "crm" ? "S" : "T"}
          </span>
          <div><strong>{surfaceSpec.productName}</strong></div>
        </header>
        <div className="crm-login-form crm-empty-action">
          <SearchX aria-hidden="true" />
          <h1 id="not-found-title">Halaman tidak ditemui</h1>
          <Link className="crm-button crm-button--primary" href="/">Ke utama</Link>
        </div>
      </section>
    </main>
  );
}
