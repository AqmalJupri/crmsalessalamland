import "server-only";

import { and, asc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDatabase } from "@/server/db/client";
import {
  authLoginAttempts,
  businessUnits,
  memberships,
  organizations,
  sessions,
  users,
} from "@/server/db/schema";
import { getRuntimeConfig } from "@/server/env";
import { ApiError } from "@/server/http/errors";
import { selectAccessScope, type AccessPreferences } from "./access-policy";
import { BUSINESS_UNIT_COOKIE, ORGANIZATION_COOKIE, SESSION_COOKIE } from "./constants";
import { hashSensitiveLookup, hashSessionToken, newSessionToken } from "./crypto";
import { addHours } from "./time";

export interface AuthenticationContext extends AccessPreferences {
  correlationId: string;
  ipAddress?: string;
  userAgent?: string;
}

interface LoginFailure {
  ok: false;
  code: string;
  message: string;
}

interface LoginSuccess {
  ok: true;
  organizationId: string;
  businessUnitId: string;
}

function optionalContextHash(value: string | undefined): Uint8Array | undefined {
  return value ? hashSensitiveLookup(value) : undefined;
}

export async function establishOidcSession(
  authSubject: string,
  context: AuthenticationContext,
): Promise<void> {
  const config = getRuntimeConfig();
  const now = new Date();
  const expiresAt = addHours(now, config.sessionTtlHours);
  const token = newSessionToken();
  const tokenHash = hashSessionToken(token);
  const attemptedIdentifierHash = hashSensitiveLookup(authSubject);
  const ipHash = optionalContextHash(context.ipAddress);
  const userAgentHash = optionalContextHash(context.userAgent?.slice(0, 2_048));
  const database = getDatabase();

  const result: LoginFailure | LoginSuccess = await database.transaction(async (transaction) => {
    const recordAttempt = async (input: {
      outcome: "SUCCESS" | "FAILURE";
      failureCode?: string;
      userId?: string;
      organizationId?: string;
    }): Promise<void> => {
      await transaction.insert(authLoginAttempts).values({
        attemptedIdentifierHash,
        outcome: input.outcome,
        correlationId: context.correlationId,
        ...(input.failureCode ? { failureCode: input.failureCode } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        ...(ipHash ? { ipHash } : {}),
        ...(userAgentHash ? { userAgentHash } : {}),
      });
    };

    const deny = async (
      code: string,
      message: string,
      evidence: { userId?: string; organizationId?: string } = {},
    ): Promise<LoginFailure> => {
      await recordAttempt({
        outcome: "FAILURE",
        failureCode: code,
        ...evidence,
      });
      return { ok: false, code, message };
    };

    const [user] = await transaction
      .select({ id: users.id, status: users.status, userType: users.userType })
      .from(users)
      .where(eq(users.authSubject, authSubject))
      .limit(1);

    if (!user) {
      return deny("ACCESS_NOT_PROVISIONED", "Akses CRM belum disediakan untuk akaun ini.");
    }
    if (user.status !== "ACTIVE") {
      return deny("USER_NOT_ACTIVE", "Akaun CRM tidak aktif.", { userId: user.id });
    }
    if (user.userType !== "HUMAN") {
      return deny("INTERACTIVE_LOGIN_FORBIDDEN", "Akaun ini tidak boleh log masuk secara interaktif.", {
        userId: user.id,
      });
    }

    const membershipRows = await transaction
      .select({
        id: memberships.id,
        organizationId: memberships.organizationId,
        businessUnitId: memberships.businessUnitId,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, user.id),
          eq(memberships.status, "ACTIVE"),
          lte(memberships.validFrom, now),
          or(isNull(memberships.validUntil), gt(memberships.validUntil, now)),
        ),
      )
      .orderBy(asc(memberships.organizationId), asc(memberships.id));

    if (membershipRows.length === 0) {
      return deny("ACTIVE_MEMBERSHIP_REQUIRED", "Tiada keahlian CRM aktif.", { userId: user.id });
    }

    const candidateOrganizationIds = [
      ...new Set(membershipRows.map((membership) => membership.organizationId)),
    ];
    const activeOrganizationRows = await transaction
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          inArray(organizations.id, candidateOrganizationIds),
          eq(organizations.status, "ACTIVE"),
        ),
      );
    const activeOrganizationIds = new Set(activeOrganizationRows.map((organization) => organization.id));
    const activeMemberships = membershipRows.filter((membership) =>
      activeOrganizationIds.has(membership.organizationId),
    );

    if (activeMemberships.length === 0) {
      return deny("ACTIVE_ORGANIZATION_REQUIRED", "Organisasi CRM tidak aktif.", { userId: user.id });
    }

    const activeUnitRows = await transaction
      .select({
        id: businessUnits.id,
        organizationId: businessUnits.organizationId,
        code: businessUnits.code,
      })
      .from(businessUnits)
      .where(
        and(
          inArray(businessUnits.organizationId, [...activeOrganizationIds]),
          eq(businessUnits.status, "ACTIVE"),
        ),
      );
    const access = selectAccessScope(activeMemberships, activeUnitRows, {
      ...(context.organizationId ? { organizationId: context.organizationId } : {}),
      ...(context.businessUnitId ? { businessUnitId: context.businessUnitId } : {}),
    });

    if (!access) {
      return deny("ACTIVE_BUSINESS_UNIT_REQUIRED", "Tiada unit perniagaan aktif yang dibenarkan.", {
        userId: user.id,
      });
    }

    await transaction.insert(sessions).values({
      organizationId: access.organizationId,
      activeBusinessUnitId: access.businessUnitId,
      userId: user.id,
      tokenHash,
      expiresAt,
      ...(ipHash ? { ipHash } : {}),
      ...(userAgentHash ? { userAgentHash } : {}),
    });
    await transaction
      .update(users)
      .set({ lastAuthenticatedAt: now })
      .where(eq(users.id, user.id));
    await recordAttempt({
      outcome: "SUCCESS",
      userId: user.id,
      organizationId: access.organizationId,
    });

    return { ok: true, ...access };
  });

  if (!result.ok) throw new ApiError(403, result.code, result.message);

  const cookieStore = await cookies();
  const sharedPreferences = {
    secure: config.nodeEnv === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
    priority: "high" as const,
  };
  cookieStore.set(SESSION_COOKIE, token, {
    ...sharedPreferences,
    httpOnly: true,
  });
  cookieStore.set(ORGANIZATION_COOKIE, result.organizationId, sharedPreferences);
  cookieStore.set(BUSINESS_UNIT_COOKIE, result.businessUnitId, sharedPreferences);
}

export async function revokeCurrentSession(reason = "USER_LOGOUT"): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const config = getRuntimeConfig();
  if (token && !config.demoMode) {
    await getDatabase()
      .update(sessions)
      .set({ status: "REVOKED", revokedAt: new Date(), revokeReason: reason })
      .where(and(eq(sessions.tokenHash, hashSessionToken(token)), eq(sessions.status, "ACTIVE")));
  }
  cookieStore.delete(SESSION_COOKIE);
}
