import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Source modules import siblings as `./name.js` for the bundler; Node's type stripping needs the
// `.ts` file, so relative `.js` specifiers from TypeScript parents are redirected when one exists.
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL?.endsWith(".ts")
    ) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

/** Import a TypeScript source module without a bundle, for unit tests of pure modules. */
export const load = (path) => import(new URL(path, import.meta.url).href);
