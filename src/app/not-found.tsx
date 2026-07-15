import { SearchX } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <main className="crm-theme crm-login-page">
      <section className="crm-login-card crm-empty-action">
        <SearchX aria-hidden="true" />
        <strong>Halaman tidak ditemui</strong>
        <Link className="crm-button crm-button--primary" href="/">Kembali</Link>
      </section>
    </main>
  );
}
