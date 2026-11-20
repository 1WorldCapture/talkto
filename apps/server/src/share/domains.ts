/*
  Public mail domains (docs/share-links-spec.md). Two people at the same company domain are treated
  as one organization sharing with itself, so their sign-up does not count. Addresses at these
  domains belong to unrelated people, so sharing a domain here says nothing. Keep this the only
  list; compare lowercased domains.
*/

/** Big public mail providers whose domains many unrelated people share. */
export const publicMailDomains: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "yandex.com",
  "qq.com",
  "163.com",
]);

/** The lowercased domain of an address, or null when it has none. */
export const domainOf = (email: string): string | null => {
  const at = email.trim().lastIndexOf("@");
  const domain =
    at < 0
      ? ""
      : email
          .trim()
          .slice(at + 1)
          .toLowerCase();
  return domain.length === 0 ? null : domain;
};

/**
 * Whether two addresses share a domain that is not a public mail domain. Subdomains count as the
 * same organization (`eng.acme.com` and `acme.com`).
 */
export const sameOrganizationDomain = (a: string, b: string) => {
  const left = domainOf(a);
  const right = domainOf(b);
  if (left === null || right === null) return false;
  if (publicMailDomains.has(left) || publicMailDomains.has(right)) return false;
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
};
