/**
 * MDX globals registry — components available inside MDX without `import`.
 * Wired via `<Content components={components} />` in `[...slug].astro`.
 */

import { Aside } from "./components/ui/aside";
import AgentGrid from "./components/AgentGrid.astro";
import DeployMap from "./components/DeployMap.astro";
import Render from "./components/Render.astro";
import ServerMap from "./components/ServerMap.astro";
import { Card } from "./components/ui/card";
import { CardGrid } from "./components/ui/card-grid";
import { Step, Steps } from "./components/ui/steps";

export const components = {
  AgentGrid,
  Aside,
  Card,
  CardGrid,
  DeployMap,
  Render,
  ServerMap,
  Step,
  Steps,
};
