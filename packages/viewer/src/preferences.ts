export interface ViewPreferences {
  scoreBreakdown: boolean;
  missionStats: boolean;
  operationalStats: boolean;
  messages: boolean;
  commentary: boolean;
  comparisonChart: boolean;
  comparisonChartCollapsed: boolean;
}

export const VIEW_PREFERENCES_KEY = "firebreak.viewer.preferences.v1";

export const DEFAULT_VIEW_PREFERENCES: ViewPreferences = {
  scoreBreakdown: true,
  missionStats: true,
  operationalStats: true,
  messages: true,
  commentary: true,
  comparisonChart: true,
  comparisonChartCollapsed: false,
};

/** Ignores malformed/old fields so adding a preference never breaks saved viewer state. */
export function parseViewPreferences(raw: string | null): ViewPreferences {
  if (!raw) return { ...DEFAULT_VIEW_PREFERENCES };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(DEFAULT_VIEW_PREFERENCES).map(([key, fallback]) => [
        key,
        typeof parsed[key] === "boolean" ? parsed[key] : fallback,
      ]),
    ) as unknown as ViewPreferences;
  } catch {
    return { ...DEFAULT_VIEW_PREFERENCES };
  }
}

export function loadViewPreferences(): ViewPreferences {
  try {
    return parseViewPreferences(localStorage.getItem(VIEW_PREFERENCES_KEY));
  } catch {
    return { ...DEFAULT_VIEW_PREFERENCES };
  }
}

export function saveViewPreferences(preferences: ViewPreferences): void {
  try {
    localStorage.setItem(VIEW_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Sandboxed or file:// exports may not expose localStorage; the viewer still works for this session.
  }
}
