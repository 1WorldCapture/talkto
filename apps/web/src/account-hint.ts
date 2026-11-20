/**
 * Whether this browser was signed in when TalkTo last checked. public/theme.js copies it onto
 * <html data-account> before the first paint, so public pages show "Sign in" or "Dashboard"
 * without switching labels when the live session check returns. The check still decides.
 */
export type AccountState = "signed-in" | "signed-out";

export const rememberAccount = (state: AccountState) => {
  document.documentElement.dataset.account = state;
  try {
    localStorage.setItem("talkto-account", state);
  } catch {
    /* Browser storage can be unavailable. */
  }
};
