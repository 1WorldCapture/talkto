import { createRoot, hydrateRoot } from "react-dom/client";
import { PublicPage, publicPages } from "./public.js";
import { AgentSymbols } from "./agent-symbols.js";
import * as Telemetry from "./telemetry.js";
import { installBreakUi } from "./dev/break-ui.js";
import { startEarlyRequests } from "./early-requests.js";
import { captureShareCode } from "./share-link.js";
import { loadVisitCounter } from "./hackathon.js";
import { loadChunk } from "./stale-chunks.js";
import "./base.css";
import "./application.css";
import "./edges.css";
import "./landing.css";
import "./landing-layout.css";
import "./setup-page.css";
import "./teams.css";
import "./access-pictures.css";
import "./legal-page.css";
import "./edges";

Telemetry.initialize();
// A share link's code (`?ref=`) is kept for after sign-up and removed from the address bar.
captureShareCode();
// Dev-only worst-case data switch; the condition is false at build time unless VITE_BREAK_UI=1.
if (import.meta.env.VITE_BREAK_UI === "1") installBreakUi();
const root = document.getElementById("root");
if (!root) throw new Error("TalkTo root element is missing");
const publicPage = publicPages.find((page) => page.path === location.pathname);
if (publicPage) {
  const page = (
    <>
      <AgentSymbols />
      <main id="stage">
        <PublicPage page={publicPage.path} />
      </main>
    </>
  );
  if (root.children.length) hydrateRoot(root, page, Telemetry.reactErrors);
  else createRoot(root, Telemetry.reactErrors).render(page);
  // After captureShareCode, so a share link's code never reaches the counter.
  loadVisitCounter();
} else {
  // Overlap the dashboard's first reads with loading its code.
  if (location.pathname === "/app" || location.pathname.startsWith("/app/"))
    startEarlyRequests(location);
  let stage: "module_load" | "mount" = "module_load";
  void loadChunk(() => import("./bootstrap.js"))
    .then(({ mountDashboard }) => {
      stage = "mount";
      mountDashboard(root);
    })
    .catch((error) => {
      Telemetry.bootstrapFailure(
        error instanceof Error ? error : new Error("Dashboard load failed"),
        stage,
      );
      root.replaceChildren();
      root.removeAttribute("data-prerender");
      createRoot(root).render(
        <main className="session-panel">
          <h1>TalkTo could not load.</h1>
          <a href={location.pathname + location.search}>Reload this page</a>
        </main>,
      );
    });
}
