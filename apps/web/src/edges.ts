// Pause the home page fragment animation while the tab is hidden.
const root = document.documentElement;

const syncPaused = (): void => {
  root.toggleAttribute("data-edges-paused", document.hidden);
};

document.addEventListener("visibilitychange", syncPaused);
syncPaused();
