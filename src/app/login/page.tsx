import type { Metadata } from "next";
import { safeReturnTo } from "@/server/auth/return-to";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Log masuk" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const query = await searchParams;
  const requestedReturnTo = Array.isArray(query.returnTo) ? query.returnTo[0] : query.returnTo;
  return (
    <main className="crm-theme crm-login-page">
      <section className="crm-login-card" aria-labelledby="login-title">
        <header className="crm-login-card__brand">
          <span className="crm-login-card__mark" aria-hidden="true">S</span>
          <div><strong id="login-title">Salam CRM</strong></div>
        </header>
        <LoginForm returnTo={safeReturnTo(requestedReturnTo)} />
      </section>
    </main>
  );
}
