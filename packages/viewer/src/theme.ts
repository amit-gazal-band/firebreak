export type ViewerTheme = "dark" | "light";

export const VIEWER_THEME_KEY = "firebreak.viewer.theme.v1";
export const DEFAULT_VIEWER_THEME: ViewerTheme = "dark";

export function parseViewerTheme(raw: string | null): ViewerTheme {
  return raw === "light" || raw === "dark" ? raw : DEFAULT_VIEWER_THEME;
}

export function loadViewerTheme(): ViewerTheme {
  try {
    return parseViewerTheme(localStorage.getItem(VIEWER_THEME_KEY));
  } catch {
    return DEFAULT_VIEWER_THEME;
  }
}

export function applyViewerTheme(theme: ViewerTheme): void {
  document.documentElement.dataset.theme = theme;
}

export function saveViewerTheme(theme: ViewerTheme): void {
  try {
    localStorage.setItem(VIEWER_THEME_KEY, theme);
  } catch {
    // Sandboxed and file:// exports may not expose localStorage.
  }
}

/** Creates a self-contained persisted theme toggle for replay, index, and reference pages. */
export function createThemeToggle(onChange?: (theme: ViewerTheme) => void): HTMLButtonElement {
  let theme = loadViewerTheme();
  applyViewerTheme(theme);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "top-action theme-toggle";
  const render = () => {
    button.textContent = theme === "dark" ? "☾ Dark" : "☀ Light";
    button.title = `Switch to ${theme === "dark" ? "light" : "dark"} mode`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(theme === "light"));
  };
  render();
  button.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    applyViewerTheme(theme);
    saveViewerTheme(theme);
    render();
    onChange?.(theme);
  });
  return button;
}
