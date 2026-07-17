import type { Metadata } from "next";
import { getProductSurfaceSpec } from "@/config/product-surface";
import { safeReturnTo } from "@/server/auth/return-to";
import { getRuntimeConfig } from "@/server/env";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Log masuk" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const query = await searchParams;
  const requestedReturnTo = Array.isArray(query.returnTo) ? query.returnTo[0] : query.returnTo;
  const surface = getRuntimeConfig().productSurface;
  const surfaceSpec = getProductSurfaceSpec(surface);
  return (
    <main className="crm-theme crm-login-page">
      <section className="crm-login-card" aria-labelledby="login-heading">
        <h1 id="login-heading" className="crm-visually-hidden">Log masuk</h1>
        <header className="crm-login-card__brand">
          <span className="crm-login-card__mark" aria-hidden="true">
            {surface === "crm" ? "S" : "T"}
          </span>
          <div><strong>{surfaceSpec.productName}</strong></div>
        </header>
        <LoginForm returnTo={safeReturnTo(requestedReturnTo)} />
      </section>
    </main>
  );
}
