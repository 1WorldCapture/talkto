import { memo, type ReactNode } from "react";
import { compiler, RuleType, type MarkdownToJSX } from "markdown-to-jsx/react";
import "./message-body.css";

const linkSchemes = new Set(["http:", "https:", "mailto:"]);
/** A bare address needs a plain local part and a letter TLD, so `pkg@1.2.3` and paths stay text. */
const bareEmail = /^[^\s@/\\]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

/** Agents write message text, so only absolute web and mail links become links. */
export const safeMessageUrl = (value: string) =>
  URL.canParse(value) && linkSchemes.has(new URL(value).protocol) ? value : null;

function MessageLink({
  href,
  title,
  children,
}: {
  readonly href?: string | undefined;
  readonly title?: string | undefined;
  readonly children?: ReactNode;
}) {
  const safe = href === undefined ? null : safeMessageUrl(href);
  if (safe === null) return <span>{children}</span>;
  return (
    <a href={safe} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** Message headings stay inside the message and never join the page outline or its ids. */
function MessageHeading({ children }: { readonly children?: ReactNode }) {
  return <p className="message-heading">{children}</p>;
}

/** Footnote bodies are the only divs without raw HTML; drop their generated ids. */
function MessageNote({ children }: { readonly children?: ReactNode }) {
  return <p className="message-note">{children}</p>;
}

const options: MarkdownToJSX.Options = {
  // Raw HTML stays visible as text; nothing in a message becomes markup it did not write as Markdown.
  disableParsingRawHTML: true,
  disableFrontmatter: true,
  forceBlock: true,
  wrapper: null,
  sanitizer: (value) => safeMessageUrl(value),
  overrides: {
    a: MessageLink,
    h1: MessageHeading,
    h2: MessageHeading,
    h3: MessageHeading,
    h4: MessageHeading,
    h5: MessageHeading,
    h6: MessageHeading,
    div: MessageNote,
  },
  renderRule: (next, node, _children, state) => {
    // Remote images would load third-party content on read; show them as links instead.
    if (node.type === RuleType.image)
      return (
        <MessageLink key={state.key} href={node.target ?? undefined}>
          {node.alt ? `Image: ${node.alt}` : (node.target ?? "Image")}
        </MessageLink>
      );
    // Bare addresses are autolinked by the parser; paths like `…/effect@4.0.0` must stay text.
    // Explicit `<mailto:…>` and `[text](mailto:…)` links keep their own text and are unaffected.
    if (node.type === RuleType.link && node.target?.startsWith("mailto:")) {
      const [only, ...rest] = node.children;
      const address = node.target.slice("mailto:".length);
      if (
        rest.length === 0 &&
        only?.type === RuleType.text &&
        only.text === address &&
        !bareEmail.test(address)
      )
        return address;
    }
    return next();
  },
};

/** A safe Markdown subset rendered as React elements: no raw HTML, images or page ids. */
export const MessageBody = memo(function MessageBody({
  body,
  className,
}: {
  readonly body: string;
  readonly className?: string;
}) {
  return (
    <div className={className ? `message-body ${className}` : "message-body"} dir="auto">
      {compiler(body, options)}
    </div>
  );
});
