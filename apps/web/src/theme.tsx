import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";
type ThemePreference = Theme | "system";

// The startup script also updates these attributes when the system theme changes.
function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-preference"],
  });
  return () => observer.disconnect();
}

function getTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function getPreference(): ThemePreference {
  const value = document.documentElement.dataset.preference;
  return value === "light" || value === "dark" ? value : "system";
}

function setPreference(value: ThemePreference) {
  document.documentElement.dataset.preference = value;
  document.documentElement.dataset.theme =
    value === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : value;
  try {
    localStorage.setItem("talkto-theme", value);
  } catch {
    /* Theme still applies when storage is unavailable. */
  }
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => "light");
  const nextTheme = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${nextTheme} theme`;
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={label}
      title={label}
      onClick={() => setPreference(nextTheme)}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {nextTheme === "light" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42m0-14.14-1.42 1.42m-11.3 11.3-1.42 1.42" />
          </>
        ) : (
          <path d="M20.9 13.3A9 9 0 0 1 10.7 3.1a9 9 0 1 0 10.2 10.2Z" />
        )}
      </svg>
    </button>
  );
}

/** Preserve approved light geometry and let the operating system choose by default. */
export function ThemeControl() {
  const theme = useSyncExternalStore(subscribeTheme, getPreference, () => "system");
  return (
    <label className="theme-control">
      Theme{" "}
      <select
        value={theme}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "system" || value === "light" || value === "dark") setPreference(value);
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
