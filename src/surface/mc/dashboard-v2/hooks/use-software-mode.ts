/**
 * G-1113.C.7 — software-mode flag (localStorage-persisted, off by default).
 *
 * Gates software-development surfaces (the Repositories panel) so the cockpit
 * stays generic-mode by default and promotes Git objects only when the
 * principal opts in. Mirrors use-theme's persistence shape.
 */
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "mc.softwareMode";

function readSoftwareMode(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage?.getItem(STORAGE_KEY) === "on";
}

export function useSoftwareMode(): { softwareMode: boolean; toggle: () => void } {
  const [softwareMode, setSoftwareMode] = useState<boolean>(() => readSoftwareMode());
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage?.setItem(STORAGE_KEY, softwareMode ? "on" : "off");
    } catch (_err) {
      // localStorage unavailable (private mode / permissions) — the flag still
      // applies in-session; persistence is best-effort (matches use-theme).
    }
  }, [softwareMode]);
  const toggle = useCallback(() => setSoftwareMode((v) => !v), []);
  return { softwareMode, toggle };
}
