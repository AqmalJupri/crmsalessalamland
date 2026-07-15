import { DomainError } from "@/domain/shared/errors";

export type LotOperationalState = "active" | "blocked" | "sold" | "retired";
export type HoldStatus = "active" | "expired" | "released" | "converted";
export type ReservationStatus = "pending" | "confirmed" | "cancelled" | "converted";

export interface HoldSnapshot {
  id: string;
  status: HoldStatus;
  expiresAt: Date;
}

export interface ReservationSnapshot {
  id: string;
  status: ReservationStatus;
}

export interface AllocationSnapshot {
  lotState: LotOperationalState;
  hold?: HoldSnapshot | null;
  reservation?: ReservationSnapshot | null;
}

function isActiveReservation(reservation?: ReservationSnapshot | null): boolean {
  return reservation?.status === "pending" || reservation?.status === "confirmed";
}

export function assertLotCanBeHeld(snapshot: AllocationSnapshot, now: Date = new Date()): void {
  if (snapshot.lotState !== "active") {
    throw new DomainError("CONFLICT", "Only an active lot can be held.", {
      lotState: snapshot.lotState,
    });
  }

  if (isActiveReservation(snapshot.reservation)) {
    throw new DomainError("CONFLICT", "The lot already has an active reservation.");
  }

  if (snapshot.hold?.status === "active" && snapshot.hold.expiresAt.getTime() > now.getTime()) {
    throw new DomainError("CONFLICT", "The lot is currently held.", {
      holdId: snapshot.hold.id,
      expiresAt: snapshot.hold.expiresAt.toISOString(),
    });
  }
}

export function transitionHold(
  hold: HoldSnapshot,
  to: Exclude<HoldStatus, "active">,
  now: Date = new Date(),
): HoldSnapshot {
  if (hold.status !== "active") {
    throw new DomainError("INVALID_TRANSITION", `A ${hold.status} hold cannot move to ${to}.`);
  }

  if (to === "converted" && hold.expiresAt.getTime() <= now.getTime()) {
    throw new DomainError("CONFLICT", "An expired hold cannot be converted.");
  }

  return { ...hold, status: to };
}

export function assertReservationCanConfirm(
  reservation: ReservationSnapshot,
  lotState: LotOperationalState,
): void {
  if (reservation.status !== "pending") {
    throw new DomainError("INVALID_TRANSITION", "Only a pending reservation can be confirmed.");
  }
  if (lotState !== "active") {
    throw new DomainError("CONFLICT", "The lot is not available for confirmation.");
  }
}
