(() => {
  const root = document.documentElement;
  // Setup (/onboarding) wears the dashboard's look, like the /app pages it leads to.
  const path = location.pathname;
  root.dataset.surface =
    path === "/app" || path.startsWith("/app/") || path === "/onboarding" ? "dashboard" : "public";
  // Last known sign-in state (src/account-hint.ts), so the account link never swaps labels.
  let account = "signed-out";
  try {
    if (localStorage.getItem("talkto-account") === "signed-in") account = "signed-in";
  } catch {
    /* Browser storage can be unavailable. */
  }
  root.dataset.account = account;
  let preference = "system";
  try {
    preference = localStorage.getItem("talkto-theme") ?? "system";
  } catch {
    /* Browser storage can be unavailable. */
  }
  if (!["system", "light", "dark"].includes(preference)) preference = "system";
  root.dataset.preference = preference;
  const media = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    root.dataset.theme =
      root.dataset.preference === "system"
        ? media.matches
          ? "dark"
          : "light"
        : root.dataset.preference;
  };
  apply();
  media.addEventListener("change", apply);
})();
