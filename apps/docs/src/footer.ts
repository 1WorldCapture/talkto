/* The docs footer's links: the public site's pages and the agent guide, then Terms and Privacy. */

export interface FooterLink {
  readonly name: string;
  readonly href: string;
}

const siteLinks: ReadonlyArray<FooterLink> = [
  { name: "About", href: "/" },
  { name: "Setup", href: "/setup" },
  { name: "Access", href: "/access" },
  { name: "Pricing", href: "/pricing" },
  { name: "Agent guide", href: "/instructions" },
  { name: "Updates", href: "/docs/updates/" },
];
const legalLinks: ReadonlyArray<FooterLink> = [
  { name: "Terms", href: "/terms" },
  { name: "Privacy", href: "/privacy" },
];

/** The footer's links. */
export function footerLinks(): ReadonlyArray<FooterLink> {
  return [...siteLinks, ...legalLinks];
}
