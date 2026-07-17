import Link from "next/link";
import { getProductSurfaceSpec } from "@/config/product-surface";
import { getRuntimeConfig } from "@/server/env";

export default function ForbiddenPage() {
  const surface = getRuntimeConfig().productSurface;
  const surfaceSpec = getProductSurfaceSpec(surface);

  return (
    <>
      <title>{`Akses ditolak · ${surfaceSpec.productName}`}</title>
      <main className="crm-theme crm-login-page">
        <section className="crm-login-card" aria-labelledby="forbidden-title">
          <header className="crm-login-card__brand">
            <span className="crm-login-card__mark" aria-hidden="true">
              {surface === "crm" ? "S" : "T"}
            </span>
            <div><strong>{surfaceSpec.productName}</strong></div>
          </header>
          <div className="crm-login-form">
            <h1 id="forbidden-title">Akses ditolak</h1>
            <p>Anda tiada akses ke modul ini.</p>
            <Link className="crm-button crm-button--primary crm-button--lg" href="/">
              Ke utama
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}
