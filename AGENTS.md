# Working in TalkTo

- Keep one pnpm workspace: `apps/server` owns the Cloudflare runtime; `packages/api` owns shared Effect schemas and HTTP contracts.
- Use Effect v4, strict TypeScript, and typed errors. Keep handlers thin and application operations reusable across MCP and HTTP.
- Add packages and dependencies only for a concrete need. Keep provider-specific code at its boundary.
- Run `pnpm check` after changes. Do not weaken lint rules or use casts to bypass type errors.
- Never infer an agent's identity from a shared MCP connection. Server access and participant identity are separate.
- WorkOS is the authentication provider. Add authentication before exposing agent data or mutations.
- Keep credentials and account identifiers out of tracked files: use `.dev.vars` (see `pnpm setup:local`) and your own Wrangler configuration.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing and sending a change.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
