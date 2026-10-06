import { describe, expect, it } from "vitest";
import { DEFAULT_VIEWER_THEME, parseViewerTheme } from "../src/theme";

describe("viewer theme", () => {
  it("keeps dark mode as the default", () => {
    expect(parseViewerTheme(null)).toBe(DEFAULT_VIEWER_THEME);
    expect(parseViewerTheme("unknown")).toBe(DEFAULT_VIEWER_THEME);
  });

  it("restores either saved theme", () => {
    expect(parseViewerTheme("dark")).toBe("dark");
    expect(parseViewerTheme("light")).toBe("light");
  });
});
