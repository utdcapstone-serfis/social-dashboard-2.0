import { useCallback, useEffect, useState } from "react";
import type { PlatformName } from "../types";
import { PLATFORM_META } from "../data/mockData";

export type Theme = "dark" | "light";

const THEME_KEY = "social-dashboard:theme";

function readTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Dark by default; the choice is kept per browser and applied to <html data-theme>. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage unavailable: the toggle still works for this visit */
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}

/**
 * Concrete colors for Recharts, which draws SVG attributes that cannot read
 * CSS variables. Mirrors the tokens in index.css.
 */
export const CHART_COLORS: Record<Theme, { panel: string; grid: string; axis: string; accent: string; accent2: string }> = {
  dark: { panel: "#0C0722", grid: "#281C56", axis: "#968CBE", accent: "#905BF4", accent2: "#C084FC" },
  light: { panel: "#FFFFFF", grid: "#DED4FA", axis: "#584C80", accent: "#6D3FE0", accent2: "#3B5BFF" },
};

/** Brand color, adjusted where it would vanish into the background (Threads is black). */
export function platformColor(name: PlatformName, theme: Theme): string {
  if (name === "Threads" && theme === "dark") return "#E8E6F0";
  return PLATFORM_META[name].color;
}
