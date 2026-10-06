import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW_PREFERENCES, parseViewPreferences } from "../src/preferences";

describe("viewer preferences", () => {
  it("uses visible defaults when no saved preference exists", () => {
    expect(parseViewPreferences(null)).toEqual(DEFAULT_VIEW_PREFERENCES);
    expect(parseViewPreferences("not json")).toEqual(DEFAULT_VIEW_PREFERENCES);
  });

  it("restores saved panel toggles and fills newer fields from defaults", () => {
    expect(parseViewPreferences('{"missionStats":false,"commentary":false}')).toEqual({
      ...DEFAULT_VIEW_PREFERENCES,
      missionStats: false,
      commentary: false,
    });
  });

  it("ignores non-boolean saved values", () => {
    expect(parseViewPreferences('{"messages":"no","comparisonChart":false}')).toEqual({
      ...DEFAULT_VIEW_PREFERENCES,
      comparisonChart: false,
    });
  });
});
