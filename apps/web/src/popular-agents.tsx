import { useId, useState, type ReactNode } from "react";

/*
  Phones show a short agent list (owner, November 15, 2026): the popular agents first, in this
  order, and the rest behind one "More agents" button. Wider screens show every list whole, in its
  own order. Every agent list on the public pages reads this one list; each shows the names it has.
*/

/** The agents a phone shows first, in the order it shows them. */
export const popularAgents = [
  "Claude Code",
  "Codex",
  "Muse",
  "Hermes",
  "OpenClaw",
  "OpenCode",
  "Pi",
  "Grok",
  "Antigravity",
] as const;

/**
 * A list's phone order: its popular agents in `popularAgents` order, then the rest in the list's
 * own order.
 */
export function phoneOrder<T extends { readonly name: string }>(items: ReadonlyArray<T>) {
  const rank = (item: T) => popularAgents.findIndex((name) => name === item.name);
  return {
    popular: items.filter((item) => rank(item) >= 0).sort((a, b) => rank(a) - rank(b)),
    rest: items.filter((item) => rank(item) < 0),
  };
}

/**
 * One agent list, drawn twice: whole, in its own order, for wider screens (`pa-wide`), and short
 * for phones (`pa-phone`), where "More agents (N)" shows the rest in place. landing.css picks one
 * by width. Without scripting, phones get the whole list, since the button needs JavaScript.
 */
export function AgentList<T extends { readonly name: string }>({
  items,
  className,
  label,
  labelledBy,
  render,
}: {
  readonly items: ReadonlyArray<T>;
  readonly className: string;
  readonly label?: string | undefined;
  readonly labelledBy?: string | undefined;
  readonly render: (item: T) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const { popular, rest } = phoneOrder(items);
  return (
    <>
      <ul className={`${className} pa-wide`} aria-label={label} aria-labelledby={labelledBy}>
        {items.map((item) => (
          <li key={item.name}>{render(item)}</li>
        ))}
      </ul>
      <div className="pa-phone" data-expanded={expanded ? "" : undefined}>
        <ul id={id} className={className} aria-label={label} aria-labelledby={labelledBy}>
          {popular.map((item) => (
            <li key={item.name}>{render(item)}</li>
          ))}
          {rest.map((item) => (
            <li key={item.name} data-rest="">
              {render(item)}
            </li>
          ))}
        </ul>
        {rest.length > 0 ? (
          <button
            className="pa-more"
            type="button"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Fewer agents" : `More agents (${rest.length})`}
          </button>
        ) : null}
      </div>
    </>
  );
}
