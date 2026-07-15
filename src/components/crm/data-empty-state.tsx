import { Inbox } from "lucide-react";

export function DataEmptyState({ label }: { label: string }) {
  return (
    <section className="crm-card crm-empty-action">
      <Inbox aria-hidden="true" />
      <strong>{label}</strong>
    </section>
  );
}
