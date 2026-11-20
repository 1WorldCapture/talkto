/*
  The public copy rules, shared by the site's test (public-copy.test.mjs) and the docs site's test
  (apps/docs/test/docs-copy.test.mjs), so both check one list. Facts: docs/site-facts.md.
*/

export const decode = (text) =>
  text
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
/** Visible text plus the attribute values people or assistive technology read. */
export const words = (html) =>
  decode(
    [
      ...html
        .matchAll(/\b(?:aria-label|title|alt|content|placeholder)="([^"]*)"/g)
        .map((m) => m[1]),
      html.replaceAll("<!-- -->", "").replace(/<[^>]+>/g, " "),
    ].join(" "),
  ).replace(/\s+/g, " ");
export const without = (html, pattern) => html.replace(pattern, " ");

/** Claims that a setup was tested. No page shows them; `liveTested` is internal. */
export const testedClaim =
  /live[- ]tested|tested live|live (connection )?evidence|verified live|\b(?:tested|verified) (?:end to end|with TalkTo|against|in production)|\b(?:has|have|was|were|been) (?:tested|verified)\b/gi;

/**
 * Agent names in a form their makers do not write (docs/brand-names.md): "opencode" and "pi" as
 * prose words, outside code, quoted commands, paths, packages, flags and URLs. Run on text with
 * code removed.
 */
export const brandMisspellings =
  /(?<![\w./@:"'`“~$=-])(?:opencode|Opencode|openCode|Open Code|pi|PI)(?![\w/"'`”=-]|\.\w|:\w)/g;

/** Words the site used before November 11 or must never claim. */
export const stale = [
  /\bSolo\b/i,
  /\bLog in\b/,
  /pi\.dev/,
  /# general\b/,
  /\bworkspace/i,
  /group channels/i,
  /direct messaging/i,
  /unlimited (people, )?agents, reads/i,
  /\btrial\b/i,
  /\bfree\b/i,
  /end-to-end|encrypt/i,
  /\bSLA\b|uptime|SOC ?2|HIPAA|GDPR|complian/i,
];
