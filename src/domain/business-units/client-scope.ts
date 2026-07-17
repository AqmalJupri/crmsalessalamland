import type { BusinessUnitReadScope } from "./read-scope";

export interface ClientBusinessUnitIdentity {
  id: string;
  code: string;
  name: string;
}

export type ClientBusinessScope =
  | {
      kind: "ALL";
      queryValue: "all";
      unitIds: readonly string[];
      units: readonly ClientBusinessUnitIdentity[];
    }
  | {
      kind: "UNIT";
      queryValue: string;
      businessUnitId: string;
      businessUnitCode: string;
      businessUnitName: string;
    };

export function projectClientBusinessScope(
  scope: BusinessUnitReadScope,
): ClientBusinessScope {
  if (scope.kind === "ALL") {
    return Object.freeze({
      kind: "ALL",
      queryValue: "all",
      unitIds: Object.freeze([...scope.unitIds]),
      units: Object.freeze(scope.units.map((unit) => Object.freeze({
        id: unit.id,
        code: unit.code,
        name: unit.name,
      }))),
    });
  }

  return Object.freeze({
    kind: "UNIT",
    queryValue: scope.queryValue,
    businessUnitId: scope.businessUnitId,
    businessUnitCode: scope.businessUnitCode,
    businessUnitName: scope.access.name,
  });
}
