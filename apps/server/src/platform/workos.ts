import {
  WorkOS,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
  GenericServerException,
} from "@workos-inc/node";
import type { OrganizationMembership, Invitation as WorkOSInvitation } from "@workos-inc/node";
import { Config, ConfigProvider, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import { describeFailure } from "../failure-log.js";
import * as Model from "./model.js";
import * as Platform from "./service.js";

/** Credentials and issuer are parsed once at the hosted composition boundary. */
export const configuration = (env: Env) =>
  Effect.gen(function* () {
    const clientId = yield* Config.string("WORKOS_CLIENT_ID");
    const apiKey = yield* Config.redacted("WORKOS_API_KEY");
    const issuer = yield* Config.string("WORKOS_ISSUER").pipe(
      Config.withDefault(`https://api.workos.com/user_management/${clientId}`),
    );
    return { clientId, apiKey, issuer };
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.mapError(
      () =>
        new Model.Failure({
          code: "identity_unavailable",
          message: "WorkOS authentication is not configured.",
        }),
    ),
  );
/** Parsed WorkOS configuration; secrets remain redacted until used by the SDK. */
export type Configuration = Effect.Success<ReturnType<typeof configuration>>;
const unavailable = () =>
  new Model.Failure({
    code: "identity_unavailable",
    message: "The identity provider is temporarily unavailable.",
  });
const unauthenticated = () =>
  new Model.Failure({
    code: "unauthenticated",
    message: "A valid TalkTo access token is required.",
  });
const InvitationRecord = Schema.Struct({
  ...P.Invitation.fields,
  createdAt: M.TimestampInput,
  expiresAt: M.TimestampInput,
});
/** WorkOS's raw page of a user's authorized Connect applications (snake case, as sent). */
const AuthorizedApplications = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  list_metadata: Schema.optionalKey(
    Schema.Struct({ after: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
});
/** One raw authorized application. Entries that do not match are skipped, not fatal. */
const AuthorizedApplication = Schema.Struct({
  id: Schema.String,
  created_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  application: Schema.Struct({
    id: Schema.String,
    client_id: Schema.String,
    name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});
/** Pages read per listing: 500 authorizations is far beyond one person's agent apps. */
const authorizedPages = 5;
const claims = Schema.Struct({
  sub: P.UserId,
  sid: Schema.NonEmptyString,
  iat: Schema.Number,
  exp: Schema.Number,
});

/** Verify first-party AuthKit session JWTs with this application's scoped JWKS. */
export const verifier = (
  config: Configuration,
  jwks: JWTVerifyGetKey = createRemoteJWKSet(
    new URL(`https://api.workos.com/sso/jwks/${config.clientId}`),
  ),
) =>
  Effect.fn("WorkOS.verify")(function* (request: Request) {
    const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (token === undefined || token.length > 16384) return yield* unauthenticated();
    const result = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(token, jwks, {
          issuer: config.issuer,
          algorithms: ["RS256"],
          requiredClaims: ["sub", "sid", "iat", "exp"],
        }),
      catch: (error) => {
        if (!(error instanceof errors.JWKSTimeout) && error instanceof errors.JOSEError)
          return unauthenticated();
        // The cause's name and code only: never the token, its claims or an error message.
        console.warn("workos: session key set unavailable", describeFailure(error));
        return unavailable();
      },
    });
    // AuthKit session JWTs may omit aud. When present it must identify this application.
    // Connect resource tokens use a separate, audience-required verifier when MCP is added.
    if (
      result.payload.aud !== undefined &&
      result.payload.aud !== config.clientId &&
      !(Array.isArray(result.payload.aud) && result.payload.aud.includes(config.clientId))
    )
      return yield* unauthenticated();
    const parsed = yield* Schema.decodeUnknownEffect(claims)(result.payload).pipe(
      Effect.mapError(unauthenticated),
    );
    return Model.actor(parsed.sub);
  });

/** Official SDK adapter for human identities, organizations, and ordered event consumption. */
export const layer = (config: Configuration) =>
  Layer.sync(Platform.Identity, () => {
    const sdk = new WorkOS(Redacted.value(config.apiKey), {
      clientId: config.clientId,
      maxRetries: 2,
    });
    // Invitation sends are external email actions without provider idempotency support.
    const emailSdk = new WorkOS(Redacted.value(config.apiKey), {
      clientId: config.clientId,
      maxRetries: 0,
    });
    const call = <A>(operation: () => Promise<A>) =>
      Effect.tryPromise({ try: operation, catch: unavailable });
    const management = <A>(operation: () => Promise<A>) =>
      Effect.tryPromise({
        try: operation,
        catch: (error) => {
          if (error instanceof NotFoundException)
            return new Model.Failure({
              code: "not_found",
              message: "The user, membership, or invitation is unavailable.",
            });
          if (error instanceof ConflictException)
            return new Model.Failure({
              code: "idempotency_conflict",
              message:
                "This request conflicts with an earlier operation. Reuse the original request or choose a new request key.",
            });
          if (
            error instanceof GenericServerException &&
            error.code === "email_already_invited_to_organization"
          )
            return new Model.Failure({
              code: "invalid_input",
              message:
                "This email already has a pending invitation. List invitations to resend or cancel it.",
            });
          if (
            error instanceof BadRequestException ||
            error instanceof UnprocessableEntityException ||
            (error instanceof GenericServerException && error.status === 400)
          )
            return new Model.Failure({
              code: "invalid_input",
              message:
                "WorkOS rejected this operation. Check the email and current membership/invitation state. List invitations before sending again.",
            });
          return unavailable();
        },
      });
    // Deletions repeat after interruptions: a resource that is already gone is the goal reached.
    const gone = <A>(operation: () => Promise<A>) =>
      Effect.tryPromise({
        try: async () => {
          try {
            return await operation();
          } catch (error) {
            if (error instanceof NotFoundException) return undefined;
            throw error;
          }
        },
        catch: unavailable,
      });
    const invitation = (value: WorkOSInvitation) =>
      Schema.decodeUnknownEffect(InvitationRecord)(value).pipe(Effect.mapError(unavailable));
    const email = <A>(operation: () => Promise<A>) =>
      management(operation).pipe(
        Effect.mapError((error) =>
          error.code === "identity_unavailable"
            ? new Model.Failure({
                code: error.code,
                message:
                  "The email action could not be confirmed. List invitations to check its state; do not automatically resend.",
              })
            : error,
        ),
      );
    const member = Effect.fn("WorkOS.decodeMembership")(function* (value: OrganizationMembership) {
      const instant = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
        value.updatedAt,
      ).pipe(Effect.mapError(unavailable));
      return yield* Schema.decodeUnknownEffect(P.Member)({
        ...value,
        role: value.role.slug,
        updatedAt: DateTime.formatIso(instant),
      }).pipe(Effect.mapError(unavailable));
    });
    const membership = Effect.fn("WorkOS.membership")(function* (
      organizationId: P.OrganizationId,
      userId: P.UserId,
    ) {
      const result = yield* call(() =>
        sdk.userManagement.listOrganizationMemberships({
          organizationId,
          userId,
          statuses: ["active", "inactive", "pending"],
          limit: 100,
        }),
      );
      const item = result.data.find((value) => value.status === "active") ?? result.data[0];
      return item === undefined ? null : yield* member(item);
    });
    const authorizedApplications = Effect.fn("WorkOS.authorizedApplications")(function* (
      userId: P.UserId,
    ) {
      const items: Model.AuthorizedApplication[] = [];
      let after: string | undefined;
      for (let page = 0; page < authorizedPages; page++) {
        const query: Record<string, string | number> =
          after === undefined ? { limit: 100 } : { limit: 100, after };
        const response = yield* call(() =>
          sdk.get<unknown>(
            `/user_management/users/${encodeURIComponent(userId)}/authorized_applications`,
            { query },
          ),
        );
        const result = yield* Schema.decodeUnknownEffect(AuthorizedApplications)(
          response.data,
        ).pipe(Effect.mapError(unavailable));
        for (const entry of result.data) {
          const raw = Schema.decodeUnknownOption(AuthorizedApplication)(entry);
          if (Option.isNone(raw)) continue;
          const value = raw.value;
          const created =
            value.created_at === undefined || value.created_at === null
              ? Option.none()
              : Schema.decodeUnknownOption(Schema.DateTimeUtcFromString)(value.created_at);
          const item = Schema.decodeUnknownOption(Model.AuthorizedApplication)({
            id: value.id,
            applicationId: value.application.id,
            clientId: value.application.client_id,
            name: (value.application.name ?? "").slice(0, 200),
            createdAt: Option.match(created, {
              onNone: () => null,
              onSome: (instant) => DateTime.formatIso(instant),
            }),
          });
          // An entry TalkTo cannot read is left out rather than failing the whole list.
          if (Option.isSome(item)) items.push(item.value);
        }
        const next = result.list_metadata?.after;
        if (next === undefined || next === null || result.data.length === 0) break;
        after = next;
      }
      return items;
    });
    return Platform.Identity.of({
      authorizedApplications,
      revokeAuthorizedApplication: Effect.fn("WorkOS.revokeAuthorizedApplication")(
        function* (userId, clientId) {
          // WorkOS takes the application's ID or client ID in the path. A shared (CIMD) client ID is
          // a URL, so its application ID is looked up instead of putting a URL in the path.
          let target = clientId;
          if (/^https:\/\//i.test(clientId)) {
            const found = (yield* authorizedApplications(userId)).find(
              (item) => item.clientId === clientId,
            );
            if (found === undefined) return;
            target = found.applicationId;
          }
          yield* gone(() =>
            sdk.delete(
              `/user_management/users/${encodeURIComponent(userId)}/authorized_applications/${encodeURIComponent(target)}`,
            ),
          );
        },
      ),
      user: Effect.fn("WorkOS.user")(function* (id) {
        return yield* Schema.decodeUnknownEffect(P.User)(
          yield* management(() => sdk.userManagement.getUser(id)),
        ).pipe(Effect.mapError(unavailable));
      }),
      invitations: Effect.fn("WorkOS.invitations")(function* (organizationId, after) {
        const result = yield* management(() =>
          sdk.userManagement.listInvitations({ organizationId, after: after ?? null, limit: 100 }),
        );
        return {
          items: yield* Effect.forEach(result.data, invitation),
          nextCursor: result.listMetadata.after ?? null,
        };
      }),
      invitation: Effect.fn("WorkOS.invitation")(function* (id) {
        return yield* invitation(yield* management(() => sdk.userManagement.getInvitation(id)));
      }),
      acceptedInvitee: Effect.fn("WorkOS.acceptedInvitee")(function* (id) {
        const value = yield* management(() => sdk.userManagement.getInvitation(id));
        return yield* Schema.decodeUnknownEffect(Schema.NullOr(P.UserId))(
          value.acceptedUserId,
        ).pipe(Effect.mapError(unavailable));
      }),
      findInvitations: Effect.fn("WorkOS.findInvitations")(function* (organizationId, email) {
        const result = yield* management(() =>
          sdk.userManagement.listInvitations({ organizationId, email, limit: 100 }),
        );
        return {
          items: yield* Effect.forEach(result.data, invitation),
          nextCursor: result.listMetadata.after ?? null,
        };
      }),
      invite: Effect.fn("WorkOS.invite")(function* (organizationId, inviter, input) {
        return yield* invitation(
          yield* email(() =>
            emailSdk.userManagement.sendInvitation({
              organizationId,
              inviterUserId: inviter,
              email: input.email,
            }),
          ),
        );
      }),
      resend: Effect.fn("WorkOS.resend")(function* (id) {
        return yield* invitation(yield* email(() => emailSdk.userManagement.resendInvitation(id)));
      }),
      cancel: Effect.fn("WorkOS.cancelInvitation")(function* (id) {
        return yield* invitation(yield* management(() => sdk.userManagement.revokeInvitation(id)));
      }),
      deactivate: Effect.fn("WorkOS.deactivateMember")(function* (value) {
        return yield* member(
          yield* management(() => sdk.userManagement.deactivateOrganizationMembership(value.id)),
        );
      }),
      createAccount: Effect.fn("WorkOS.createAccount")(function* (reservation) {
        if (reservation.organizationId !== null) return reservation.organizationId;
        const externalId = `talkto:${reservation.id}`;
        const existing = yield* Effect.tryPromise({
          try: async () => {
            try {
              return await sdk.organizations.getOrganizationByExternalId(externalId);
            } catch (error) {
              if (error instanceof NotFoundException) return null;
              throw error;
            }
          },
          catch: unavailable,
        });
        const organization =
          existing ??
          (yield* call(() =>
            sdk.organizations.createOrganization(
              { name: reservation.name, externalId },
              { idempotencyKey: externalId },
            ),
          ));
        const id = yield* Schema.decodeUnknownEffect(P.OrganizationId)(organization.id).pipe(
          Effect.mapError(unavailable),
        );
        const prior = yield* membership(id, reservation.createdBy);
        if (prior === null)
          yield* call(() =>
            sdk.userManagement.createOrganizationMembership({
              organizationId: id,
              userId: reservation.createdBy,
            }),
          );
        return id;
      }),
      membership,
      memberships: Effect.fn("WorkOS.memberships")(function* (userId, after, limit) {
        const result = yield* call(() =>
          sdk.userManagement.listOrganizationMemberships({
            userId,
            limit,
            after: after ?? null,
          }),
        );
        return {
          items: yield* Effect.forEach(result.data, member),
          nextCursor: result.listMetadata.after ?? null,
        };
      }),
      members: Effect.fn("WorkOS.members")(function* (organizationId, after, limit) {
        const result = yield* call(() =>
          sdk.userManagement.listOrganizationMemberships({
            organizationId,
            statuses: ["active"],
            limit,
            after: after ?? null,
          }),
        );
        return {
          items: yield* Effect.forEach(result.data, member),
          nextCursor: result.listMetadata.after ?? null,
        };
      }),
      deleteUser: Effect.fn("WorkOS.deleteUser")(function* (id) {
        yield* gone(() => sdk.userManagement.deleteUser(id));
      }),
      deleteOrganization: Effect.fn("WorkOS.deleteOrganization")(function* (account) {
        const organizationId =
          account.organizationId ??
          (yield* gone(() => sdk.organizations.getOrganizationByExternalId(`talkto:${account.id}`)))
            ?.id;
        if (organizationId === undefined) return;
        yield* gone(() => sdk.organizations.deleteOrganization(organizationId));
      }),
      events: Effect.fn("WorkOS.events")(function* (cursor, startedAt) {
        const options = {
          events: [
            "organization_membership.created",
            "organization_membership.updated",
            "organization_membership.deleted",
            "user.deleted",
            "organization.deleted",
          ],
          limit: 100,
        } as const;
        const result = yield* call(() =>
          sdk.events.listEvents(
            cursor === null
              ? { ...options, events: [...options.events], rangeStart: startedAt }
              : { ...options, events: [...options.events], after: cursor },
          ),
        );
        return yield* Effect.forEach(result.data, (event) =>
          Effect.gen(function* () {
            const instant = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
              event.createdAt,
            ).pipe(Effect.mapError(unavailable));
            const at = DateTime.formatIso(instant);
            switch (event.event) {
              case "organization_membership.created":
              case "organization_membership.updated":
              case "organization_membership.deleted": {
                const value = event.data;
                const removed = event.event === "organization_membership.deleted";
                const updated = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
                  value.updatedAt,
                ).pipe(Effect.mapError(unavailable));
                return yield* Schema.decodeUnknownEffect(Model.IdentityEvent)({
                  kind: "membership",
                  id: event.id,
                  member: {
                    ...value,
                    status: removed ? "deleted" : value.status,
                    role: "role" in value ? value.role.slug : "member",
                    updatedAt: removed ? at : DateTime.formatIso(updated),
                  },
                }).pipe(Effect.mapError(unavailable));
              }
              case "user.deleted":
                return yield* Schema.decodeUnknownEffect(Model.IdentityEvent)({
                  kind: "user_deleted",
                  id: event.id,
                  userId: event.data.id,
                  at,
                }).pipe(Effect.mapError(unavailable));
              case "organization.deleted":
                return yield* Schema.decodeUnknownEffect(Model.IdentityEvent)({
                  kind: "organization_deleted",
                  id: event.id,
                  organizationId: event.data.id,
                  at,
                }).pipe(Effect.mapError(unavailable));
              default:
                return yield* unavailable();
            }
          }),
        );
      }),
    });
  });
