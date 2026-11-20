import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLinkProps } from "@tanstack/react-router";
import { describeAgentType } from "@talkto/api/agent-types";
import { ApiError } from "./api.js";
import { formatRetry } from "./format.js";
import type { DashboardSearch } from "./router.js";

/** Internal dashboard link; filters and continuations belong to the URL. */
export function AppLink({
  path = "",
  children,
  className,
  search = {},
  current = false,
  prefetch,
}: {
  readonly path?: string | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly search?: DashboardSearch;
  readonly current?: boolean;
  /** Start the target's first read when the pointer reaches the link, before the click. */
  readonly prefetch?: (() => void) | undefined;
}) {
  const link = useLinkProps({
    to: "/app/$",
    params: { _splat: path },
    search,
    className,
    activeProps: {},
  });
  return (
    <a
      {...link}
      // The owning view resolves query-based tabs and parent navigation together.
      // Override the router's path match, including its accessibility marker.
      aria-current={current ? "page" : undefined}
      data-status={current ? "active" : undefined}
      onPointerEnter={prefetch}
      onPointerDown={prefetch}
    >
      {children}
    </a>
  );
}
/** Preserve the actual agent identity in a compact icon treatment. */
export function AgentIcon({ type }: { readonly type: string }) {
  const agent = describeAgentType(type);
  return (
    <svg className="agent-icon" role="img" aria-label={agent.label} focusable="false">
      <title>{agent.label}</title>
      <use href={`#agent-${agent.icon}`} />
    </svg>
  );
}
/** A signed-in person's mark: their initial, where an agent shows its tool's icon. */
export function PersonMark({ name }: { readonly name: string }) {
  return (
    <span className="agent-icon person-mark" role="img" aria-label={`Person ${name}`}>
      <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
    </span>
  );
}
/** Whoever sent or joined: a person's initial, or the agent's tool icon. */
export function ParticipantMark({
  participant,
}: {
  readonly participant:
    | { readonly name: string; readonly agentType: string; readonly kind?: "person" }
    | undefined;
}) {
  return participant?.kind === "person" ? (
    <PersonMark name={participant.name} />
  ) : (
    <AgentIcon type={participant?.agentType ?? ""} />
  );
}
/** Shared monochrome organization mark; the adjacent name supplies its accessible label. */
export function OrganizationIcon() {
  return (
    <svg
      className="organization-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="9" cy="7" r="3" />
      <path d="M2 20v-3a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v3H2ZM16 4a3 3 0 0 1 0 6M18 12a5 5 0 0 1 4 5v3h-3" />
    </svg>
  );
}
/** Safe expected errors retain their diagnostic ID; unknown errors never expose request payloads. */
export function Notice({
  error,
  stale = false,
  retry,
}: {
  readonly error: Error | null;
  readonly stale?: boolean;
  readonly retry?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="notice" role="alert">
      <p>
        {stale && "Showing the last confirmed result. "}
        {error instanceof ApiError ? error.message : "This view could not be loaded."}
        {error instanceof ApiError && error.retryAt && ` ${formatRetry(error.retryAt)}`}
      </p>
      {error instanceof ApiError && error.requestId && <small>Request {error.requestId}</small>}
      {retry && (
        <button className="text-button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
/** Long free text shows two lines until the reader asks for the rest. */
export function ClampedText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string | undefined;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open || typeof ResizeObserver === "undefined") return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);
  return (
    <div className="clamped-text">
      <p ref={ref} className={`${className ?? ""}${open ? "" : " is-clamped"}`}>
        {text}
      </p>
      {(clipped || open) && (
        <button className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
/** Native modal owns focus containment, Escape and return to the opener. */
export function Dialog({
  title,
  close,
  className,
  children,
}: {
  readonly title: string;
  readonly close: () => void;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    // Start on the dialog's main control when it names one, not on the close button.
    const start = dialog?.querySelector("[data-autofocus]");
    if (start instanceof HTMLElement) start.focus();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className ? `modal ${className}` : "modal"}
      aria-labelledby={titleId}
      onCancel={close}
      onClose={close}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button onClick={close} aria-label="Close dialog">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="m3.5 3.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </header>
      {children}
    </dialog>
  );
}
/** Server search is debounced without filtering a partial local page. */
export function Search({
  value,
  onChange,
  label,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
}) {
  const [draft, setDraft] = useState(value);
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  }, [onChange]);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => change.current(draft.trim()), 300);
    return () => clearTimeout(timer);
  }, [draft, value]);
  return (
    <input
      type="search"
      aria-label={label}
      placeholder={label}
      value={draft}
      maxLength={128}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}
/** Opaque continuations never imply totals or page numbers the API did not return. */
export function Pagination({
  cursor,
  next,
  onChange,
  count,
}: {
  readonly cursor?: string | undefined;
  readonly next: string | null;
  readonly onChange: (cursor?: string) => void;
  readonly count: number;
}) {
  return (
    <nav className="ops-pagination" aria-label="Pagination">
      <span>{count.toLocaleString()} shown</span>
      <div>
        {cursor && <button onClick={() => onChange()}>First page</button>}
        <button
          disabled={!next}
          onClick={() => {
            if (next) onChange(next);
          }}
        >
          Next →
        </button>
      </div>
    </nav>
  );
}
