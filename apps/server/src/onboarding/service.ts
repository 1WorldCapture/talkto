import { Clock, Context, DateTime, Effect, Layer } from "effect";
import * as O from "@talkto/api/onboarding";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import * as Platform from "../platform/service.js";
import * as Model from "../platform/model.js";
import { Identifiers } from "../talkto.js";
import * as Starter from "../starter/service.js";
import * as StarterModel from "../starter/model.js";

type Operation<A> = Effect.Effect<A, Model.Failure>;
/** User-scoped persistence with optimistic concurrency across tabs and devices. */
export class Store extends Context.Service<
  Store,
  {
    readonly read: (userId: P.UserId) => Operation<O.State>;
    readonly save: (userId: P.UserId, state: O.State, at: M.Timestamp) => Operation<O.State>;
  }
>()("@talkto/onboarding/Store") {}
/** Current access is rechecked by the server for every observation. */
export class Servers extends Context.Service<
  Servers,
  {
    readonly read: (
      actor: Model.Actor,
      id: M.ServerId,
      names: readonly [M.Name, M.Name],
      agents: O.AgentLookups,
      /** Slots 2 and up; absent for a run that has none. */
      more: O.MoreLookups | undefined,
      /** When the run started: an agent the person registered since then fills an empty slot. */
      since: M.Timestamp,
    ) => Operation<O.ServerProgress | null>;
  }
>()("@talkto/onboarding/Servers") {}
/** Persistent onboarding orchestrates existing application operations without granting authority. */
export class Service extends Context.Service<
  Service,
  {
    readonly state: (actor: Model.Actor) => Operation<O.State>;
    /** `InvitationLimited` means the invite step sent nothing and can be tried again later. */
    readonly command: (
      actor: Model.Actor,
      command: O.Command,
      evidence?: Model.Evidence,
    ) => Effect.Effect<O.State, Model.Failure | Model.InvitationLimited>;
    readonly progress: (actor: Model.Actor, runId: O.RunId) => Operation<O.Progress>;
  }
>()("@talkto/onboarding/Service") {}
const invalid = (message: string) => new Model.Failure({ code: "invalid_input", message });
/** Safe conflict response asks stale clients to reload before taking another action. */
export const conflict = () =>
  new Model.Failure({
    code: "idempotency_conflict",
    message: "Setup changed in another tab. Reload your progress to continue.",
  });
const now = Clock.currentTimeMillis.pipe(
  Effect.map((ms) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)))),
);
const ready = (run: O.Run | null) =>
  run?.setup.kind === "ready"
    ? Effect.succeed({ run, setup: run.setup })
    : Effect.fail(invalid("Choose a server first."));
/** Recoverable workflows; only an explicitly claimed invitation intent can send mail. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* Store;
    const servers = yield* Servers;
    const platform = yield* Platform.Service;
    const identity = yield* Platform.Identity;
    const directory = yield* Platform.Directory;
    const ids = yield* Identifiers;
    const starter = yield* Starter.Service;
    /** Free-start denials keep the setup form; other starter failures are retryable storage. */
    const fromStarter = <A, R>(effect: Effect.Effect<A, StarterModel.Failure | Model.Failure, R>) =>
      effect.pipe(
        Effect.mapError((error) =>
          error._tag === "PlatformFailure"
            ? error
            : new Model.Failure({
                code:
                  error._tag === "StarterDenied" ? "starter_unavailable" : "storage_unavailable",
                message: error.message,
              }),
        ),
      );
    const save = Effect.fn("Onboarding.save")(function* (actor: Model.Actor, state: O.State) {
      return yield* store.save(actor.userId, state, yield* now);
    });
    const makeRun = Effect.fn("Onboarding.makeRun")(function* (setup: O.Run["setup"]) {
      const id = O.RunId.make(yield* ids.uuid());
      return O.Run.make({
        id,
        setup,
        step: "server",
        createdAt: yield* now,
        // Nothing is picked for the person: `setup` stays absent until they choose an agent.
        agents: [
          {
            name: M.Name.make(`builder-${id.slice(0, 8)}`),
            agentType: O.unchosenAgentType,
            registrationKey: O.agentRequestKey(id, 0),
          },
          {
            name: M.Name.make(`reviewer-${id.slice(0, 8)}`),
            agentType: O.unchosenAgentType,
            registrationKey: O.agentRequestKey(id, 1),
          },
        ],
        invitation: null,
      });
    });
    const observe = Effect.fn("Onboarding.observe")(function* (actor: Model.Actor, run: O.Run) {
      const { setup } = yield* ready(run);
      // WorkOS membership and the DO grant are both authoritative, never the saved run.
      const context = yield* platform.managedServer(actor, setup.accountId, setup.serverId).pipe(
        Effect.catchIf(
          (e) => e.code === "not_found" || e.code === "forbidden",
          () => Effect.succeed(null),
        ),
      );
      if (context === null || !context.permissions.readMessages) return null;
      const lookup = (slot: 0 | 1) => ({
        requestKey: run.agents[slot].registrationKey ?? O.agentRequestKey(run.id, slot),
        legacyName: run.agents[slot].registrationKey === undefined ? run.agents[slot].name : null,
      });
      // Slots 2 and up are saved with their key; they never had a legacy name.
      const more = run.moreAgents?.map((slot, index) => ({
        requestKey:
          slot.registrationKey ?? M.RequestKey.make(`onboarding:${run.id}:agent:${index + 2}`),
        legacyName: null,
      }));
      return yield* servers.read(
        actor,
        setup.serverId,
        [run.agents[0].name, run.agents[1].name],
        [lookup(0), lookup(1)],
        more,
        run.createdAt,
      );
    });
    const invitationEvidence = Effect.fn("Onboarding.invitationEvidence")(function* (
      actor: Model.Actor,
      run: O.Run,
    ) {
      const { setup } = yield* ready(run);
      const account = yield* platform.getAccount(actor, setup.accountId);
      if (
        !account.permissions.manageMembers ||
        run.invitation?.id === null ||
        run.invitation === null
      )
        return { invitation: null, invitee: null, grant: null };
      const invitation = yield* identity.invitation(run.invitation.id);
      if (
        invitation.organizationId !== account.organizationId ||
        invitation.email.toLowerCase() !== run.invitation.email.toLowerCase()
      )
        return yield* invalid("This invitation does not belong to this setup.");
      const userId =
        invitation.state === "accepted" ? yield* identity.acceptedInvitee(invitation.id) : null;
      const member =
        userId === null ? null : yield* identity.membership(account.organizationId, userId);
      const invitee = member?.status === "active" ? yield* identity.user(member.userId) : null;
      const command = invitee === null ? null : yield* directory.grant(setup.serverId, invitee.id);
      const grant = command === null ? null : P.Grant.make(command);
      return { invitation, invitee, grant };
    });
    const progress = Effect.fn("Onboarding.progress")(function* (
      actor: Model.Actor,
      runId: O.RunId,
    ) {
      const state = yield* store.read(actor.userId);
      if (state.run?.id !== runId) return yield* conflict();
      const { run } = yield* ready(state.run);
      const server = yield* observe(actor, run);
      const evidence =
        server !== null && run.step === "share"
          ? yield* invitationEvidence(actor, run)
          : { invitation: null, invitee: null, grant: null };
      return { runId, server, ...evidence };
    });
    return Service.of({
      state: (actor) => store.read(actor.userId),
      progress,
      command: Effect.fn("Onboarding.command")(function* (
        actor,
        command,
        evidence = Model.noEvidence,
      ) {
        const state = yield* store.read(actor.userId);
        if (state.revision !== command.revision) return yield* conflict();
        switch (command.kind) {
          case "configure": {
            if (state.run !== null && state.run.setup.kind !== "draft")
              return yield* invalid("Use another server to start a different setup.");
            if (command.accountId !== null) yield* platform.getAccount(actor, command.accountId);
            const setup: O.Run["setup"] = {
              kind: "draft",
              accountId: command.accountId,
              organizationName: command.organizationName,
              serverName: command.serverName,
            };
            const run = state.run === null ? yield* makeRun(setup) : { ...state.run, setup };
            return yield* save(actor, { ...state, run, dismissedAt: null });
          }
          case "provision": {
            if (state.run === null) return yield* invalid("Name your server first.");
            if (state.run.setup.kind === "ready") return state;
            // A free-start denial the person can fix (verify email, admissions full) is reported
            // before the setup is marked as creating, so the form keeps their input.
            if (state.run.setup.kind === "draft")
              yield* fromStarter(starter.route(actor, state.run.setup.accountId, evidence));
            const claimed =
              state.run.setup.kind === "creating"
                ? state
                : yield* save(actor, {
                    ...state,
                    run: { ...state.run, setup: { ...state.run.setup, kind: "creating" } },
                  });
            const run = claimed.run;
            if (run === null || run.setup.kind !== "creating") return yield* conflict();
            const setup = run.setup;
            const accountId =
              setup.accountId ??
              (yield* platform.createAccount(actor, {
                name: setup.organizationName,
                requestKey: M.RequestKey.make(`onboarding:${run.id}:account`),
              })).id;
            const input = {
              name: setup.serverName,
              requestKey: M.RequestKey.make(`onboarding:${run.id}:server`),
            };
            // The first server opens the free start when this person is eligible; an existing grant
            // for the organization always resumes. Everyone else creates a server as before.
            const server = yield* fromStarter(
              starter.create(actor, accountId, input, evidence),
            ).pipe(
              Effect.tapError((error) =>
                error.code === "starter_unavailable"
                  ? Effect.gen(function* () {
                      // Back to the editable form; the organization's request key stays the same.
                      const latest = yield* store.read(actor.userId);
                      if (latest.run?.id === run.id && latest.run.setup.kind === "creating")
                        yield* save(actor, {
                          ...latest,
                          run: { ...latest.run, setup: { ...setup, kind: "draft" } },
                        });
                    }).pipe(Effect.ignore)
                  : Effect.void,
              ),
            );
            const created = (current: O.State, latest: O.Run) =>
              save(actor, {
                ...current,
                run: {
                  ...latest,
                  setup: { kind: "ready", accountId, serverId: server.id },
                  step: "agents",
                },
              });
            // Usually nothing saved since the claim, so save on its revision; reread only if it moved.
            return yield* created(claimed, run).pipe(
              Effect.catchIf(
                (error) => error.code === "idempotency_conflict",
                () =>
                  Effect.gen(function* () {
                    const latest = yield* store.read(actor.userId);
                    if (latest.run?.id !== run.id) return yield* conflict();
                    if (latest.run.setup.kind === "ready") return latest;
                    return yield* created(latest, latest.run);
                  }),
              ),
            );
          }
          case "use_server": {
            if (state.run?.setup.kind === "creating" || state.run?.invitation?.id === null)
              return yield* invalid(
                "Recover the pending operation before choosing another server.",
              );
            const server = yield* platform.managedServer(
              actor,
              command.accountId,
              command.serverId,
            );
            if (server.status !== "ready" || !server.permissions.readMessages)
              return yield* invalid("Choose an accessible server that is ready.");
            const run = yield* makeRun({
              kind: "ready",
              accountId: command.accountId,
              serverId: command.serverId,
            });
            return yield* save(actor, {
              ...state,
              run: { ...run, step: "agents" },
              dismissedAt: null,
            });
          }
          case "dismiss":
            return yield* save(actor, { ...state, dismissedAt: yield* now });
          case "new_run": {
            if (
              state.run?.setup.kind === "creating" ||
              (state.run?.invitation !== null && state.run?.invitation?.id === null)
            )
              return yield* invalid("Recover the pending operation before starting another setup.");
            return yield* save(actor, { ...state, run: null, dismissedAt: null });
          }
          case "replay":
            return yield* save(actor, {
              ...state,
              dismissedAt: null,
              run: state.run === null ? null : { ...state.run, step: "server" },
            });
          case "step": {
            if (state.run === null) return yield* invalid("Choose a server first.");
            if (command.step !== "server") yield* ready(state.run);
            return yield* save(actor, { ...state, run: { ...state.run, step: command.step } });
          }
          case "agents": {
            const { run } = yield* ready(state.run);
            const evidence = yield* observe(actor, run);
            if (evidence === null)
              return yield* invalid(
                "Server access is unavailable. Choose another server or ask its owner for access.",
              );
            if (
              evidence.agents.some(
                (agent, index) =>
                  agent !== null && command.types[index] !== run.agents[index]?.agentType,
              )
            )
              return yield* invalid(
                "An agent has already joined this slot. Start another setup to use different agents.",
              );
            // An older browser picks types only; a changed type no longer matches the saved guide.
            const retype = (index: 0 | 1): O.Slot => {
              const { setup, ...slot } = run.agents[index];
              const agentType = command.types[index];
              const next: O.Slot = {
                ...slot,
                name: evidence.agents[index]?.name ?? slot.name,
                agentType,
              };
              return setup === undefined || agentType !== slot.agentType
                ? next
                : { ...next, setup };
            };
            return yield* save(actor, {
              ...state,
              run: { ...run, agents: [retype(0), retype(1)] },
            });
          }
          case "choose": {
            const { run } = yield* ready(state.run);
            const evidence = yield* observe(actor, run);
            if (evidence === null)
              return yield* invalid(
                "Server access is unavailable. Choose another server or ask its owner for access.",
              );
            const arrivals = O.progressAgents(evidence);
            if (arrivals[command.slot] != null)
              return yield* invalid(
                "An agent has already joined this slot. Start another setup to use different agents.",
              );
            if (command.slot === 0 || command.slot === 1) {
              const slot = {
                ...run.agents[command.slot],
                agentType: command.agentType,
                setup: command.setup,
              };
              const agents: O.Run["agents"] =
                command.slot === 0 ? [slot, run.agents[1]] : [run.agents[0], slot];
              return yield* save(actor, { ...state, run: { ...run, agents } });
            }
            // Slots 2 and up: change one that is waiting, or add the next one once every slot
            // before it has an agent, so slots never have gaps and each is asked for in turn.
            const more = run.moreAgents ?? [];
            const at = command.slot - 2;
            const existing = more[at];
            if (existing === undefined && (at !== more.length || arrivals.some((a) => a === null)))
              return yield* invalid("Connect the agents you already picked first.");
            const slot: O.Slot = {
              name: existing?.name ?? M.Name.make(`agent${command.slot + 1}-${run.id.slice(0, 8)}`),
              agentType: command.agentType,
              registrationKey: O.agentRequestKey(run.id, command.slot),
              setup: command.setup,
            };
            const moreAgents = existing === undefined ? [...more, slot] : more.with(at, slot);
            return yield* save(actor, { ...state, run: { ...run, moreAgents } });
          }
          case "invite": {
            const { run, setup } = yield* ready(state.run);
            if (run.invitation !== null)
              return yield* invalid(
                "An invitation was already requested. Check its status or manage invitations in Members.",
              );
            const account = yield* platform.getAccount(actor, setup.accountId);
            const server = yield* platform.managedServer(actor, setup.accountId, setup.serverId);
            if (!account.permissions.manageMembers || !server.permissions.manageAccess)
              return yield* invalid(
                "Ask the organization and server owner to invite someone and grant access.",
              );
            const intent = { email: command.email, requestedAt: yield* now, id: null };
            const saved = yield* save(actor, { ...state, run: { ...run, invitation: intent } });
            const invitation = yield* platform
              .sendInvitation(actor, setup.accountId, { email: command.email })
              .pipe(
                // A budget refusal is certain to have sent nothing, so release the saved intent
                // and let the person try again when the budget allows.
                Effect.tapErrorTag("InvitationLimited", () =>
                  store.read(actor.userId).pipe(
                    Effect.flatMap((latest) =>
                      latest.revision === saved.revision && latest.run !== null
                        ? save(actor, { ...latest, run: { ...latest.run, invitation: null } })
                        : Effect.void,
                    ),
                    Effect.ignore,
                  ),
                ),
              );
            const latest = yield* store.read(actor.userId);
            if (
              latest.run?.id !== run.id ||
              latest.run.invitation?.requestedAt !== intent.requestedAt
            )
              return yield* conflict();
            return yield* save(actor, {
              ...latest,
              run: { ...latest.run, invitation: { ...intent, id: invitation.id } },
            });
          }
          case "check_invitation": {
            const { run, setup } = yield* ready(state.run);
            if (run.invitation === null || run.invitation.id !== null) return state;
            const account = yield* platform.getAccount(actor, setup.accountId);
            if (!account.permissions.manageMembers)
              return yield* invalid("Only the organization owner can check invitations.");
            const found = yield* identity.findInvitations(
              account.organizationId,
              run.invitation.email,
            );
            const matching = found.items.filter(
              (i) =>
                i.organizationId === account.organizationId &&
                i.email.toLowerCase() === run.invitation?.email.toLowerCase() &&
                (i.state === "pending" ||
                  (i.state === "accepted" &&
                    Date.parse(i.createdAt) >=
                      Date.parse(run.invitation?.requestedAt ?? run.createdAt) - 60_000)),
            );
            const invitation =
              matching.length === 1 && found.nextCursor === null ? matching[0] : undefined;
            if (invitation === undefined)
              return yield* invalid(
                "No invitation is confirmed yet. Check Members before sending another invitation.",
              );
            return yield* save(actor, {
              ...state,
              run: { ...run, invitation: { ...run.invitation, id: invitation.id } },
            });
          }
          case "grant": {
            const { run, setup } = yield* ready(state.run);
            const evidence = yield* invitationEvidence(actor, run);
            if (evidence.invitee === null)
              return yield* invalid("Wait for the invitation to be accepted by an active member.");
            yield* platform.grantAccess(actor, setup.serverId, evidence.invitee.id);
            return state;
          }
          case "finish": {
            const { run } = yield* ready(state.run);
            const evidence = yield* observe(actor, run);
            const [first, second] = evidence?.agents ?? [null, null];
            const complete = first !== null && second !== null && first.id !== second.id;
            const at = yield* now;
            const agents: O.Run["agents"] = [
              { ...run.agents[0], name: first?.name ?? run.agents[0].name },
              { ...run.agents[1], name: second?.name ?? run.agents[1].name },
            ];
            // Slots 2 and up keep the names their agents joined with, like the first two.
            const done: O.Run =
              run.moreAgents === undefined
                ? { ...run, step: "done", agents }
                : {
                    ...run,
                    step: "done",
                    agents,
                    moreAgents: run.moreAgents.map((slot, index) => ({
                      ...slot,
                      name: evidence?.moreAgents?.[index]?.name ?? slot.name,
                    })),
                  };
            return yield* save(actor, {
              ...state,
              completedAt: complete ? (state.completedAt ?? at) : state.completedAt,
              dismissedAt: complete ? null : at,
              run: done,
            });
          }
        }
      }),
    });
  }),
);
