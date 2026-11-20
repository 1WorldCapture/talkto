import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createAppRouter } from "./router.js";
import { createServices, Services } from "./session.js";
import { reactErrors } from "./telemetry.js";
import "./brand-app.css";
import "./layout.css";

/** Load authentication, contracts and dashboard dependencies only for application routes. */
export function mountDashboard(root: HTMLElement) {
  root.replaceChildren();
  root.removeAttribute("data-prerender");
  document.body.dataset.surface = "dashboard";
  const services = createServices(location.origin);
  const router = createAppRouter();
  createRoot(root, reactErrors).render(
    <Services.Provider value={services}>
      <QueryClientProvider client={services.queries}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </Services.Provider>,
  );
}
