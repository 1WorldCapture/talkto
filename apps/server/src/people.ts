import { Option, Schema } from "effect";
import * as M from "@talkto/api/models";

/**
 * Internal header carrying the signed-in person's display name, reduced to the `Name` format. The
 * hosted Worker sets it from the person's WorkOS profile after verifying their sign-in; every
 * ingress removes copies a caller sends, so it never comes from a request.
 */
export const nameHeader = "x-talkto-person-name";
/** Name used when no profile is available, as on the local development server. */
export const fallbackName = M.Name.make("Person");
/** A person's agent type; agent types are free-form, so this needs no registration. */
export const agentType = M.AgentType.make("person");
/** Room left for a numeric suffix such as "-12" within the 64-character name limit. */
const baseLength = 56;

/** The routes where a person acts as themselves; only these use the person's name. */
export const isPersonPath = (pathname: string) =>
  /^\/v1\/servers\/[^/]+\/people\/me(?:\/direct-chats|\/messages|\/renames)?$/.test(pathname);
/**
 * The routes that can create a person's participant, so they need the person's name: joining,
 * opening a chat, renaming an agent (the notice names the person), and removing or restoring one.
 */
export const createsPerson = (pathname: string) =>
  /^\/v1\/servers\/[^/]+\/people\/me(?:\/direct-chats|\/renames)?$/.test(pathname) ||
  /^\/v1\/servers\/[^/]+\/participants\/[^/]+\/(?:remove|restore)$/.test(pathname);

const reduce = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z]+/, "")
    .slice(0, baseLength)
    .replace(/-+$/, "");

/** First name, else the email's local part, reduced to the `Name` format. */
export const displayName = (profile: {
  readonly firstName: string | null;
  readonly email: string;
}): M.Name => {
  for (const candidate of [profile.firstName ?? "", profile.email.split("@")[0] ?? ""]) {
    const name = Schema.decodeUnknownOption(M.Name)(reduce(candidate));
    if (Option.isSome(name)) return name.value;
  }
  return fallbackName;
};

/** Parse the trusted header the Worker set; anything else falls back to the generic name. */
export const fromHeader = (value: string | null): M.Name =>
  Option.getOrElse(Schema.decodeUnknownOption(M.Name)(reduce(value ?? "")), () => fallbackName);

/** The name itself, then "Name-2" through "Name-20"; the caller falls back to an ID suffix. */
export const candidates = function* (name: M.Name): Generator<M.Name> {
  yield name;
  const base = name.slice(0, baseLength);
  for (let suffix = 2; suffix <= 20; suffix++) yield M.Name.make(`${base}-${suffix}`);
};
