import { OperationState } from "@/components/ui/operation-state";

export function DataEmptyState({ label }: { label: string }) {
  return <OperationState kind="empty" label={label} />;
}
