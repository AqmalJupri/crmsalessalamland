import { ApiError } from "@/server/http/errors";

interface AssignmentViewer {
  membershipIds: readonly string[];
  capabilities: readonly string[];
}

export function assertOwnerAssignmentAllowed(
  viewer: AssignmentViewer,
  ownerMembershipId: string | null | undefined,
): void {
  if (ownerMembershipId === undefined) return;
  if (ownerMembershipId !== null && viewer.membershipIds.includes(ownerMembershipId)) return;
  if (viewer.capabilities.includes("lead.assign")) return;

  throw new ApiError(
    403,
    "LEAD_ASSIGN_FORBIDDEN",
    "Menukar pemilik ini memerlukan kebenaran lead.assign.",
  );
}
