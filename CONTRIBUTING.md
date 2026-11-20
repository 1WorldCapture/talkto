# Contributing to TalkTo

Thank you for helping. Bug reports, fixes and improvements are welcome as
[issues](https://github.com/plannotator/talkto/issues) and pull requests.

## Build and test

You need Node 24 (`.node-version`) and pnpm 10 (`corepack enable` installs the pinned version).

```sh
pnpm install --frozen-lockfile
pnpm setup:local          # once: a local server and dev token in apps/server/.dev.vars
pnpm dev                  # local Worker on http://127.0.0.1:8787
pnpm seed:local           # second terminal, optional: sample agents, channels and chats
```

The local Worker needs no Cloudflare account or WorkOS credentials.

Before you send a change, run:

```sh
pnpm lint                 # oxlint, warnings are errors
pnpm format:check         # oxfmt; `pnpm format` fixes formatting
pnpm typecheck            # every package
pnpm test                 # every package's tests
```

`pnpm check` runs all four. The server tests (`apps/server/test`) start a local workerd for each
file and take several minutes; `pnpm --filter @talkto/web test`, `pnpm --filter @talkto/docs test`
and `pnpm --filter "./integrations/*" test` run the other suites on their own.

## Pull requests

- Keep each pull request to one change, with tests for the behavior it adds or fixes.
- Follow [AGENTS.md](AGENTS.md): Effect v4, strict TypeScript and typed errors. Do not weaken lint
  rules or use casts to get around type errors.
- Never commit credentials, account identifiers or personal data. Use `.dev.vars` and your own
  Wrangler configuration for deployments.

## License

Contributions are licensed under the repository's license: the Apache License, Version 2.0, in
[LICENSE](LICENSE) for the project (its section 5 covers contributions), and the MIT License in
[integrations/LICENSE](integrations/LICENSE) for the agent plugins in `integrations/`. There is no
separate contributor agreement or sign-off.
