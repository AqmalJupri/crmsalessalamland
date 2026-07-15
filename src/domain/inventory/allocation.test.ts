import { describe, expect, it } from "vitest";
import {
  assertLotCanBeHeld,
  assertReservationCanConfirm,
  transitionHold,
} from "./allocation";

const now = new Date("2026-07-15T08:00:00.000Z");

describe("lot allocation", () => {
  it("allows an active lot with no live allocation", () => {
    expect(() => assertLotCanBeHeld({ lotState: "active" }, now)).not.toThrow();
  });

  it("rejects a lot that is not operationally active", () => {
    expect(() => assertLotCanBeHeld({ lotState: "blocked" }, now)).toThrow(/active lot/i);
  });

  it("rejects a live hold", () => {
    expect(() =>
      assertLotCanBeHeld(
        {
          lotState: "active",
          hold: { id: "hold-1", status: "active", expiresAt: new Date("2026-07-15T09:00:00Z") },
        },
        now,
      ),
    ).toThrow(/held/i);
  });

  it("treats an elapsed active hold as available for transactional expiry", () => {
    expect(() =>
      assertLotCanBeHeld(
        {
          lotState: "active",
          hold: { id: "hold-1", status: "active", expiresAt: new Date("2026-07-15T07:00:00Z") },
        },
        now,
      ),
    ).not.toThrow();
  });

  it("rejects a lot with a pending reservation", () => {
    expect(() =>
      assertLotCanBeHeld(
        { lotState: "active", reservation: { id: "reservation-1", status: "pending" } },
        now,
      ),
    ).toThrow(/reservation/i);
  });

  it("rejects a lot with a confirmed reservation", () => {
    expect(() =>
      assertLotCanBeHeld(
        { lotState: "active", reservation: { id: "reservation-1", status: "confirmed" } },
        now,
      ),
    ).toThrow(/reservation/i);
  });

  it("ignores a cancelled reservation", () => {
    expect(() =>
      assertLotCanBeHeld(
        { lotState: "active", reservation: { id: "reservation-1", status: "cancelled" } },
        now,
      ),
    ).not.toThrow();
  });

  it("cannot convert an expired hold", () => {
    expect(() =>
      transitionHold(
        { id: "hold-1", status: "active", expiresAt: new Date("2026-07-15T07:00:00Z") },
        "converted",
        now,
      ),
    ).toThrow(/expired/i);
  });

  it("does not transition a hold that has already left active state", () => {
    expect(() =>
      transitionHold(
        { id: "hold-1", status: "released", expiresAt: new Date("2026-07-15T09:00:00Z") },
        "expired",
        now,
      ),
    ).toThrow(/released hold cannot move/i);
  });

  it("transitions an active hold to a terminal state", () => {
    expect(
      transitionHold(
        { id: "hold-1", status: "active", expiresAt: new Date("2026-07-15T09:00:00Z") },
        "converted",
        now,
      ),
    ).toEqual({
      id: "hold-1",
      status: "converted",
      expiresAt: new Date("2026-07-15T09:00:00Z"),
    });
  });

  it("confirms only pending reservations on active lots", () => {
    expect(() =>
      assertReservationCanConfirm({ id: "reservation-1", status: "pending" }, "active"),
    ).not.toThrow();
    expect(() =>
      assertReservationCanConfirm({ id: "reservation-1", status: "confirmed" }, "active"),
    ).toThrow(/only a pending reservation/i);
    expect(() =>
      assertReservationCanConfirm({ id: "reservation-1", status: "pending" }, "sold"),
    ).toThrow(/not available/i);
  });
});
