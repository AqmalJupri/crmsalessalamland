import { ApplicationShell } from "@/components/crm/application-shell";
import { getViewer } from "@/server/auth/viewer";

export const dynamic = "force-dynamic";

export default async function CrmLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const viewer = await getViewer();
  if (!viewer) return children;

  return (
    <ApplicationShell
      viewer={{
        displayName: viewer.displayName,
        businessUnitId: viewer.businessUnitId,
        businessUnits: viewer.businessUnits,
        capabilities: viewer.capabilities,
        demo: viewer.demo,
      }}
    >
      {children}
    </ApplicationShell>
  );
}
