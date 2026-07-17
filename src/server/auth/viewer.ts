import "server-only";

import { and, asc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDatabase } from "@/server/db/client";
import {
  businessUnits,
  memberships,
  membershipRoles,
  organizations,
  roleCapabilities,
  roles,
  sessions,
  users,
} from "@/server/db/schema";
import { getRuntimeConfig } from "@/server/env";
import { ApiError } from "@/server/http/errors";
import { BUSINESS_UNIT_COOKIE, SESSION_COOKIE } from "./constants";
import { hashSessionToken } from "./crypto";
import { CRM_MODULE_READ_CAPABILITIES } from "./module-access";
import { safeReturnTo } from "./return-to";
import {
  type CapabilityRecordScopes,
} from "./capability-policy";
import {
  deriveBusinessUnitAccess,
  deriveBusinessUnitCommandViewer,
} from "./business-scope";

export { SESSION_COOKIE } from "./constants";

export interface ViewerBusinessUnit {
  id: string;
  name: string;
  code: string;
  /** Compatibility route key until workspace URLs use the canonical business-unit code directly. */
  slug: string;
}

export interface ViewerBusinessUnitAccess extends ViewerBusinessUnit {
  membershipIds: readonly string[];
  capabilities: readonly string[];
  capabilityRecordScopes: CapabilityRecordScopes;
}

export interface Viewer {
  userId: string;
  displayName: string;
  sessionExpiresAt: Date | null;
  organizationId: string;
  businessUnitId: string;
  businessUnits: readonly ViewerBusinessUnit[];
  businessUnitAccess: readonly ViewerBusinessUnitAccess[];
  activeMembershipId: string;
  membershipIds: readonly string[];
  capabilities: readonly string[];
  capabilityRecordScopes: CapabilityRecordScopes;
  demo: boolean;
}

const demoViewer: Viewer = {
  userId: "00000000-0000-4000-8000-000000000001",
  displayName: "Pengguna Demo",
  sessionExpiresAt: null,
  organizationId: "00000000-0000-4000-8000-000000000010",
  businessUnitId: "00000000-0000-4000-8000-000000000101",
  businessUnits: [
    {
      id: "00000000-0000-4000-8000-000000000101",
      name: "Salam Land",
      code: "salam-land",
      slug: "salam-land",
    },
    {
      id: "00000000-0000-4000-8000-000000000102",
      name: "Bumi Hayat Printing",
      code: "bumi-hayat",
      slug: "bumi-hayat",
    },
    {
      id: "00000000-0000-4000-8000-000000000103",
      name: "Barakah Emas",
      code: "barakah-emas",
      slug: "barakah-emas",
    },
  ],
  businessUnitAccess: [
    {
      id: "00000000-0000-4000-8000-000000000101",
      name: "Salam Land",
      code: "salam-land",
      slug: "salam-land",
      membershipIds: ["00000000-0000-4000-8000-000000000201"],
      capabilities: [
        ...new Set([
          ...CRM_MODULE_READ_CAPABILITIES,
          "lead.create",
          "lead.update",
          "lead.reopen",
        ]),
      ].sort(),
      capabilityRecordScopes: { "lead.update": ["BUSINESS_UNIT"] },
    },
    {
      id: "00000000-0000-4000-8000-000000000102",
      name: "Bumi Hayat Printing",
      code: "bumi-hayat",
      slug: "bumi-hayat",
      membershipIds: ["00000000-0000-4000-8000-000000000202"],
      capabilities: [
        ...new Set([
          ...CRM_MODULE_READ_CAPABILITIES,
          "lead.create",
          "lead.update",
          "lead.reopen",
        ]),
      ].sort(),
      capabilityRecordScopes: { "lead.update": ["BUSINESS_UNIT"] },
    },
    {
      id: "00000000-0000-4000-8000-000000000103",
      name: "Barakah Emas",
      code: "barakah-emas",
      slug: "barakah-emas",
      membershipIds: ["00000000-0000-4000-8000-000000000203"],
      capabilities: [
        ...new Set([
          ...CRM_MODULE_READ_CAPABILITIES,
          "lead.create",
          "lead.update",
          "lead.reopen",
        ]),
      ].sort(),
      capabilityRecordScopes: { "lead.update": ["BUSINESS_UNIT"] },
    },
  ],
  activeMembershipId: "00000000-0000-4000-8000-000000000201",
  membershipIds: ["00000000-0000-4000-8000-000000000201"],
  capabilities: [
    ...new Set([
      ...CRM_MODULE_READ_CAPABILITIES,
      "lead.create",
      "lead.update",
      "lead.reopen",
    ]),
  ].sort(),
  capabilityRecordScopes: { "lead.update": ["BUSINESS_UNIT"] },
  demo: true,
};

async function resolveViewer(): Promise<Viewer | null> {
  const config = getRuntimeConfig();
  if (config.demoMode && config.nodeEnv !== "production") return demoViewer;

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const now = new Date();
  const database = getDatabase();
  const [session] = await database
    .select({
      sessionId: sessions.id,
      organizationId: sessions.organizationId,
      activeBusinessUnitId: sessions.activeBusinessUnitId,
      lastSeenAt: sessions.lastSeenAt,
      sessionExpiresAt: sessions.expiresAt,
      userId: users.id,
      displayName: users.displayName,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(organizations, eq(organizations.id, sessions.organizationId))
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        eq(sessions.status, "ACTIVE"),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        eq(users.status, "ACTIVE"),
        eq(users.userType, "HUMAN"),
        eq(organizations.status, "ACTIVE"),
      ),
    )
    .limit(1);

  if (!session) return null;

  const activeMemberships = await database
    .select({
      id: memberships.id,
      businessUnitId: memberships.businessUnitId,
    })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, session.userId),
        eq(memberships.organizationId, session.organizationId),
        eq(memberships.status, "ACTIVE"),
        lte(memberships.validFrom, now),
        or(isNull(memberships.validUntil), gt(memberships.validUntil, now)),
      ),
    );

  if (activeMemberships.length === 0) return null;

  const organizationWide = activeMemberships.some((membership) => membership.businessUnitId === null);
  const explicitUnitIds = activeMemberships.flatMap((membership) =>
    membership.businessUnitId ? [membership.businessUnitId] : [],
  );
  if (!organizationWide && explicitUnitIds.length === 0) return null;

  const allowedUnits = await database
    .select({ id: businessUnits.id, name: businessUnits.name, code: businessUnits.code })
    .from(businessUnits)
    .where(
      and(
        eq(businessUnits.organizationId, session.organizationId),
        eq(businessUnits.status, "ACTIVE"),
        organizationWide ? undefined : inArray(businessUnits.id, explicitUnitIds),
      ),
    )
    .orderBy(asc(businessUnits.code), asc(businessUnits.id));

  if (allowedUnits.length === 0) return null;

  const preferredBusinessUnitId = cookieStore.get(BUSINESS_UNIT_COOKIE)?.value;
  const selectedUnit =
    allowedUnits.find((unit) => unit.id === preferredBusinessUnitId) ??
    allowedUnits.find((unit) => unit.id === session.activeBusinessUnitId) ??
    allowedUnits[0]!;
  const capabilityRows = await database
    .select({
      membershipId: membershipRoles.membershipId,
      capability: roleCapabilities.capabilityKey,
      constraints: roleCapabilities.constraints,
    })
    .from(membershipRoles)
    .innerJoin(
      roleCapabilities,
      and(
        eq(roleCapabilities.organizationId, membershipRoles.organizationId),
        eq(roleCapabilities.roleId, membershipRoles.roleId),
      ),
    )
    .innerJoin(
      roles,
      and(
        eq(roles.organizationId, membershipRoles.organizationId),
        eq(roles.id, membershipRoles.roleId),
      ),
    )
    .where(
      and(
        eq(membershipRoles.organizationId, session.organizationId),
        inArray(
          membershipRoles.membershipId,
          activeMemberships.map((membership) => membership.id),
        ),
        lte(membershipRoles.validFrom, now),
        or(isNull(membershipRoles.validUntil), gt(membershipRoles.validUntil, now)),
        eq(roles.status, "ACTIVE"),
      ),
    );

  const viewerUnits = allowedUnits.map((unit) => ({ ...unit, slug: unit.code }));
  const businessUnitAccess = deriveBusinessUnitAccess(
    viewerUnits,
    activeMemberships,
    capabilityRows,
  );
  const selectedAccess = businessUnitAccess.find((unit) => unit.id === selectedUnit.id);
  if (!selectedAccess || selectedAccess.membershipIds.length === 0) return null;

  const lastSeenRefreshBefore = new Date(now.getTime() - 5 * 60 * 1_000);
  if (
    session.activeBusinessUnitId !== selectedUnit.id ||
    session.lastSeenAt < lastSeenRefreshBefore
  ) {
    await database
      .update(sessions)
      .set({ activeBusinessUnitId: selectedUnit.id, lastSeenAt: now })
      .where(and(eq(sessions.id, session.sessionId), eq(sessions.status, "ACTIVE")));
  }

  return {
    userId: session.userId,
    displayName: session.displayName,
    sessionExpiresAt: session.sessionExpiresAt,
    organizationId: session.organizationId,
    businessUnitId: selectedUnit.id,
    businessUnits: viewerUnits,
    businessUnitAccess,
    activeMembershipId: selectedAccess.membershipIds[0]!,
    membershipIds: selectedAccess.membershipIds,
    capabilities: selectedAccess.capabilities,
    capabilityRecordScopes: selectedAccess.capabilityRecordScopes,
    demo: false,
  };
}

export const getViewer = cache(resolveViewer);

export async function requireViewer(returnTo = "/"): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect(`/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`);
  return viewer;
}

export async function requireApiViewer(capability?: string): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new ApiError(401, "UNAUTHENTICATED", "Log masuk diperlukan.");
  if (capability && !viewer.capabilities.includes(capability)) {
    throw new ApiError(403, "FORBIDDEN", "Anda tiada akses untuk tindakan ini.");
  }
  return viewer;
}

export async function requireApiViewerForBusinessUnit(
  capability: string,
  businessUnitId: string,
): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new ApiError(401, "UNAUTHENTICATED", "Log masuk diperlukan.");
  return deriveBusinessUnitCommandViewer(viewer, capability, businessUnitId);
}
