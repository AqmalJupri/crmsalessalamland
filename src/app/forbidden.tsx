import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Akses ditolak" };

export default function ForbiddenPage() {
  return (
    <main className="crm-theme crm-login-page">
      <section className="crm-login-card" aria-labelledby="forbidden-title">
        <header className="crm-login-card__brand">
          <span className="crm-login-card__mark" aria-hidden="true">S</span>
          <div><strong>Salam CRM</strong></div>
        </header>
        <div className="crm-login-form">
          <h1 id="forbidden-title">Akses ditolak</h1>
          <p>Anda tidak mempunyai kebenaran untuk membuka modul ini.</p>
          <Link className="crm-button crm-button--primary crm-button--lg" href="/">
            Kembali ke utama
          </Link>
        </div>
      </section>
    </main>
  );
}
