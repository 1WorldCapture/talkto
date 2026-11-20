/**
 * A first organization's suggested name. A company address names the company from its domain:
 * brightfield.com → Brightfield, acme-labs.co.uk → Acme Labs. A personal address (gmail.com,
 * outlook.com, icloud.com…) names a person, not a company, so the person's first name does:
 * "Sam’s organization", or "My organization" without one. The person can always change it.
 */
const personal = new Set([
  "aol",
  "fastmail",
  "gmail",
  "gmx",
  "googlemail",
  "hey",
  "hotmail",
  "icloud",
  "live",
  "mac",
  "mail",
  "me",
  "msn",
  "outlook",
  "pm",
  "proton",
  "protonmail",
  "qq",
  "tutanota",
  "yahoo",
  "yandex",
  "ymail",
  "zoho",
  "163",
]);
/** Second-level labels under a country code: the name is the label before them. */
const secondLevel = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);
export const fallbackOrganizationName = "My organization";
export const fallbackServerName = "My server";
/** Organization names are at most 100 UTF-8 bytes, like server names. */
const fits = (name: string) => name !== "" && new TextEncoder().encode(name).length <= 100;

/** "Sam’s …" from a first name, when there is one and it fits; otherwise null. */
const possessive = (firstName: string | null, noun: string) => {
  const first = firstName?.trim() ?? "";
  const name = `${first}’s ${noun}`;
  return first !== "" && fits(name) ? name : null;
};

/** A first server's suggested name: "Sam’s server", or "My server" without a first name. */
export const defaultServerName = (firstName: string | null): string =>
  possessive(firstName, "server") ?? fallbackServerName;

export function defaultOrganizationName(email: string, firstName: string | null = null): string {
  const personName = possessive(firstName, "organization") ?? fallbackOrganizationName;
  const address = email.trim();
  const at = address.lastIndexOf("@");
  const labels = address
    .slice(at + 1)
    .toLowerCase()
    .split(".")
    .filter((label) => label !== "");
  if (at < 1 || labels.length < 2) return personName;
  const rest = labels.slice(0, -1);
  if (rest.length > 1 && secondLevel.has(rest.at(-1) ?? "")) rest.pop();
  const label = rest.at(-1) ?? "";
  if (personal.has(label)) return personName;
  const name = label
    .split("-")
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return fits(name) ? name : personName;
}
