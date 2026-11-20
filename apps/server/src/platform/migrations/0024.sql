-- Self-host sign-in with Better Auth (docs/self-host-better-auth.md). A copy that signs people in
-- with Better Auth keeps its sign-in records here: people's passwords, browser sessions, and the
-- OAuth clients, grants and tokens of agents' MCP sign-ins. People, organizations and invitations
-- stay in the local_* tables of 0021.sql. Additive only: deployments that use WorkOS or Cloudflare
-- Access, talkto.sh included, never write these tables.
--
-- The columns are Better Auth 1.7's own schema for its core tables, its JWT plugin and its OAuth
-- provider plugin, with a `ba_` prefix on every table so none can meet a TalkTo table. Better
-- Auth writes and reads them; TalkTo reads `ba_user`, `ba_oauth_client` and `ba_oauth_consent`, and
-- deletes a person's rows when their account is deleted or an agent app is signed out. Times are
-- ISO 8601 text, except `ba_rate_limit.lastRequest` (epoch milliseconds).
--
-- `ba_user.id` equals the person's `local_users.id`. `ba_account.password` holds Better Auth's
-- scrypt hash, never a password. `ba_jwks.privateKey` is encrypted with BETTER_AUTH_SECRET.
-- `ba_session.token`, and the `token` columns of the OAuth token tables, are what a browser or an
-- agent holds; they are credentials, so never copy this database anywhere you would not copy a
-- password file.
create table "ba_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
create table "ba_session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "ba_user" ("id") on delete cascade);
create table "ba_account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "ba_user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
create table "ba_verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
create table "ba_jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" date not null, "expiresAt" date, "alg" text, "crv" text);
create table "ba_oauth_client" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" integer, "skipConsent" integer, "enableEndSession" integer, "subjectType" text, "scopes" text, "clientCredentialsScopes" text, "userId" text references "ba_user" ("id") on delete cascade, "createdAt" date, "updatedAt" date, "name" text, "uri" text, "icon" text, "contacts" text, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" text not null, "postLogoutRedirectUris" text, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" integer, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" text, "responseTypes" text, "requirePKCE" integer, "dpopBoundAccessTokens" integer, "referenceId" text, "metadata" text);
create table "ba_oauth_resource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" text, "customClaims" text, "dpopBoundAccessTokensRequired" integer, "disabled" integer, "createdAt" date, "updatedAt" date, "policyVersion" integer, "metadata" text);
create table "ba_oauth_client_resource" ("id" text not null primary key, "clientId" text not null references "ba_oauth_client" ("clientId") on delete cascade, "resourceId" text not null references "ba_oauth_resource" ("identifier") on delete cascade, "metadata" text, "createdAt" date);
create table "ba_oauth_refresh_token" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "ba_oauth_client" ("clientId") on delete cascade, "sessionId" text references "ba_session" ("id") on delete set null, "userId" text not null references "ba_user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "rotatedAt" date, "rotationReplayResponse" text, "rotationReplayExpiresAt" date, "authTime" date, "confirmation" text, "scopes" text not null);
create table "ba_oauth_access_token" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "ba_oauth_client" ("clientId") on delete cascade, "sessionId" text references "ba_session" ("id") on delete set null, "userId" text references "ba_user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "refreshId" text references "ba_oauth_refresh_token" ("id") on delete cascade, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "confirmation" text, "scopes" text not null);
create table "ba_oauth_consent" ("id" text not null primary key, "clientId" text not null references "ba_oauth_client" ("clientId") on delete cascade, "userId" text references "ba_user" ("id") on delete cascade, "referenceId" text, "resources" text, "requestedUserInfoClaims" text, "scopes" text not null, "createdAt" date not null, "updatedAt" date not null);
create table "ba_oauth_client_assertion" ("id" text not null primary key, "expiresAt" date not null);
create table "ba_rate_limit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);
create index "ba_session_userId_idx" on "ba_session" ("userId");
create index "ba_account_userId_idx" on "ba_account" ("userId");
create index "ba_verification_identifier_idx" on "ba_verification" ("identifier");
create index "ba_oauth_client_userId_idx" on "ba_oauth_client" ("userId");
create index "ba_oauth_client_resource_clientId_idx" on "ba_oauth_client_resource" ("clientId");
create index "ba_oauth_client_resource_resourceId_idx" on "ba_oauth_client_resource" ("resourceId");
create index "ba_oauth_refresh_token_clientId_idx" on "ba_oauth_refresh_token" ("clientId");
create index "ba_oauth_refresh_token_sessionId_idx" on "ba_oauth_refresh_token" ("sessionId");
create index "ba_oauth_refresh_token_userId_idx" on "ba_oauth_refresh_token" ("userId");
create index "ba_oauth_refresh_token_authorizationCodeId_idx" on "ba_oauth_refresh_token" ("authorizationCodeId");
create index "ba_oauth_access_token_clientId_idx" on "ba_oauth_access_token" ("clientId");
create index "ba_oauth_access_token_sessionId_idx" on "ba_oauth_access_token" ("sessionId");
create index "ba_oauth_access_token_userId_idx" on "ba_oauth_access_token" ("userId");
create index "ba_oauth_access_token_authorizationCodeId_idx" on "ba_oauth_access_token" ("authorizationCodeId");
create index "ba_oauth_access_token_refreshId_idx" on "ba_oauth_access_token" ("refreshId");
create index "ba_oauth_consent_clientId_idx" on "ba_oauth_consent" ("clientId");
create index "ba_oauth_consent_userId_idx" on "ba_oauth_consent" ("userId");
create unique index "ba_oauth_client_resource_clientId_resourceId_uidx" on "ba_oauth_client_resource" ("clientId", "resourceId");
