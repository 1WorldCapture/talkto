import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type * as D from "@talkto/api/dashboard";
import type * as M from "@talkto/api/models";
import type * as P from "@talkto/api/platform";
import { AgentIcon, Notice } from "./components.js";
import { denied, request } from "./api.js";
import { useHuman, useServices } from "./session.js";
import { useInspection } from "./inspection.js";
import { TimelineSendersDialog } from "./timeline-senders.js";
import { formatActivityTime } from "./activity-time.js";
import "./activity-timeline.css";

const windows = [
  { value: "hour", label: "1 hour" },
  { value: "day", label: "24 hours" },
  { value: "week", label: "7 days" },
] as const;
const number = (value: number) => value.toLocaleString();

/** Independent, authorized server totals; feed search and loaded pages never change the chart. */
export function ActivityTimeline({
  accountId,
  serverId,
  range,
  at,
  window,
  onRange,
  onSelect,
  onClear,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly range: NonNullable<D.TimelineInput["range"]>;
  readonly at?: M.Timestamp | undefined;
  readonly window?: D.FeedWindow | undefined;
  readonly onRange: (range: NonNullable<D.TimelineInput["range"]>) => void;
  readonly onSelect: (window: D.FeedWindow, at: M.Timestamp) => void;
  readonly onClear: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const [senders, setSenders] = useState<{
    readonly serverId: M.ServerId;
    readonly timeline: D.Timeline;
  } | null>(null);
  const result = useQuery({
    queryKey: ["human", user.id, accountId, serverId, "timeline", range, at],
    queryFn: ({ signal }) =>
      request(
        api.server.serverTimeline({
          params: { serverId },
          query: at ? { range, at } : { range },
        }),
        signal,
      ),
    // Anchoring the same chart after a brush should not remove keyboard focus while it loads.
    placeholderData: (previous) =>
      previous?.data.bucketMillis ===
      (range === "hour" ? 60_000 : range === "day" ? 900_000 : 3_600_000)
        ? previous
        : undefined,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
  return (
    <section className="ops-timeline" aria-label="Server message timeline">
      <header className="ops-timeline-header">
        <div>
          <h2>Message activity</h2>
          {window ? (
            <button
              className="ops-timeline-clear"
              aria-label="Clear range from timeline"
              onClick={onClear}
            >
              Clear range
            </button>
          ) : (
            <span>Drag to filter</span>
          )}
        </div>
        <div className="ops-timeline-ranges" role="group" aria-label="Activity time range">
          {windows.map((preset) => (
            <button
              key={preset.value}
              aria-pressed={range === preset.value}
              onClick={() => onRange(preset.value)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </header>
      <Notice
        error={result.error}
        stale={!!result.data && !denied(result.error)}
        retry={() => {
          void result.refetch();
        }}
      />
      {result.isPending && (
        <p className="ops-empty" role="status">
          Loading activity…
        </p>
      )}
      {!denied(result.error) && result.data && (
        <TimelineChart
          key={range}
          data={result.data.data}
          window={window}
          onSelect={onSelect}
          onClear={onClear}
          onShowSenders={(timeline) => setSenders({ serverId, timeline })}
        />
      )}
      {!denied(result.error) && senders?.serverId === serverId && (
        <TimelineSendersDialog
          accountId={accountId}
          serverId={serverId}
          start={senders.timeline.windowStart}
          end={senders.timeline.windowEnd}
          close={() => setSenders(null)}
        />
      )}
    </section>
  );
}

/** Inspectable time histogram with zero intervals and keyboard navigation, plus ranked senders. */
export function TimelineChart({
  data,
  window,
  onSelect,
  onClear,
  onShowSenders,
}: {
  readonly data: D.Timeline;
  readonly window?: D.FeedWindow | undefined;
  readonly onSelect: (window: D.FeedWindow, at: M.Timestamp) => void;
  readonly onClear: () => void;
  readonly onShowSenders: (timeline: D.Timeline) => void;
}) {
  const [held, setHeld] = useState(false);
  const [draft, setDraft] = useState<{ readonly anchor: number; readonly focus: number } | null>(
    null,
  );
  const pointer = useRef<{ readonly id: number; readonly anchor: number } | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  const { displayed = data } = useInspection(data, held || draft !== null);
  const [selected, setSelected] = useState<number | null>(null);
  const [tooltipDismissed, setTooltipDismissed] = useState(false);
  const tooltipId = useId();
  useEffect(() => {
    if (selected === null || tooltipDismissed) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTooltipDismissed(true);
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [selected, tooltipDismissed]);
  const bars = useRef(new Map<number, HTMLButtonElement>());
  const maximum = Math.max(1, ...displayed.buckets.map((bucket) => bucket.messageCount));
  const active = selected === null ? undefined : displayed.buckets[selected];
  const interval = displayed.bucketMillis / 60_000;
  const first = draft ? displayed.buckets[Math.min(draft.anchor, draft.focus)] : undefined;
  const last = draft ? displayed.buckets[Math.max(draft.anchor, draft.focus)] : undefined;
  const selection = first && last ? { start: first.start, end: last.end } : window;
  const duration =
    new Date(displayed.windowEnd).getTime() - new Date(displayed.windowStart).getTime();
  const percent = (stamp: M.Timestamp) =>
    Math.max(
      0,
      Math.min(
        100,
        ((new Date(stamp).getTime() - new Date(displayed.windowStart).getTime()) / duration) * 100,
      ),
    );
  const apply = (anchor: number, focus: number) => {
    const start = displayed.buckets[Math.min(anchor, focus)]?.start;
    const end = displayed.buckets[Math.max(anchor, focus)]?.end;
    if (start && end) onSelect({ start, end }, displayed.windowEnd);
    setDraft(null);
  };
  const indexAt = (clientX: number) => {
    const bounds = plot.current?.getBoundingClientRect();
    return bounds
      ? Math.max(
          0,
          Math.min(
            displayed.buckets.length - 1,
            Math.floor(((clientX - bounds.left) / bounds.width) * displayed.buckets.length),
          ),
        )
      : 0;
  };
  const cancel = () => {
    const id = pointer.current?.id;
    pointer.current = null;
    if (id !== undefined && plot.current?.hasPointerCapture(id))
      plot.current.releasePointerCapture(id);
    setDraft(null);
  };
  const tooltipRange = draft && selection ? selection : active;
  const showTooltip = selected !== null && !!tooltipRange && !tooltipDismissed;
  return (
    <div className="ops-timeline-content">
      <div className="ops-timeline-totals">
        <strong className="ops-timeline-metric">
          {number(displayed.messageCount)} <span>total messages</span>
        </strong>
        <span>{interval < 60 ? `${interval} min` : `${interval / 60} hour`} intervals</span>
      </div>
      <div
        className="ops-timeline-plot"
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => {
          if (!pointer.current) {
            setHeld(false);
            setSelected(null);
          }
        }}
        onFocus={() => setHeld(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setHeld(false);
            setSelected(null);
            cancel();
          }
        }}
      >
        <div className="ops-timeline-scale" aria-hidden="true">
          <span>{number(maximum)}</span>
          <span>0</span>
        </div>
        <div
          className="ops-timeline-bars"
          role="group"
          ref={plot}
          aria-label="Message counts by interval. Arrow keys inspect; Shift and arrows select a range; Enter applies; Escape dismisses details, then clears the range."
          data-filtered={selection ? "true" : undefined}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0 || !displayed.buckets.length) return;
            const index = indexAt(event.clientX);
            pointer.current = { id: event.pointerId, anchor: index };
            event.currentTarget.setPointerCapture(event.pointerId);
            setDraft({ anchor: index, focus: index });
            setSelected(index);
            setTooltipDismissed(false);
            setHeld(true);
            bars.current.get(index)?.focus({ preventScroll: true });
          }}
          onPointerMove={(event) => {
            if (pointer.current?.id !== event.pointerId) return;
            const index = indexAt(event.clientX);
            setDraft({ anchor: pointer.current.anchor, focus: index });
            setSelected(index);
          }}
          onPointerUp={(event) => {
            if (pointer.current?.id !== event.pointerId) return;
            const anchor = pointer.current.anchor;
            pointer.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            apply(anchor, indexAt(event.clientX));
          }}
          onPointerCancel={cancel}
          onLostPointerCapture={() => {
            if (pointer.current) cancel();
          }}
        >
          {selection && duration > 0 && (
            <div
              className="ops-timeline-selection"
              aria-hidden="true"
              style={{
                left: `${percent(selection.start)}%`,
                right: `${100 - percent(selection.end)}%`,
              }}
            />
          )}
          {displayed.buckets.map((bucket, index) => (
            <button
              key={index}
              ref={(element) => {
                if (element) bars.current.set(index, element);
                else bars.current.delete(index);
              }}
              tabIndex={index === (selected ?? 0) ? 0 : -1}
              aria-label={`${formatActivityTime(bucket.start)} to ${formatActivityTime(bucket.end)}: ${number(bucket.messageCount)} messages from ${number(bucket.participantCount)} agents`}
              data-selected={selected === index ? "true" : undefined}
              aria-describedby={selected === index && showTooltip ? tooltipId : undefined}
              aria-pressed={
                !!selection && bucket.end > selection.start && bucket.start < selection.end
              }
              onPointerEnter={() => {
                if (!pointer.current) {
                  setSelected(index);
                  setTooltipDismissed(false);
                }
              }}
              onFocus={() => {
                setSelected(index);
                setTooltipDismissed(false);
              }}
              onClick={(event) => {
                // Keyboard and assistive activation have no pointer gesture.
                if (event.detail === 0) apply(index, index);
              }}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? Math.min(displayed.buckets.length - 1, index + 1)
                    : event.key === "ArrowLeft"
                      ? Math.max(0, index - 1)
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? displayed.buckets.length - 1
                          : undefined;
                if (next !== undefined) {
                  event.preventDefault();
                  setDraft(event.shiftKey ? { anchor: draft?.anchor ?? index, focus: next } : null);
                  bars.current.get(next)?.focus({ preventScroll: true });
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  apply(draft?.anchor ?? index, draft?.focus ?? index);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  if (draft || pointer.current) cancel();
                  else if (showTooltip) setTooltipDismissed(true);
                  else onClear();
                }
              }}
            >
              <span style={{ height: `${(bucket.messageCount / maximum) * 100}%` }} />
            </button>
          ))}
          {showTooltip && tooltipRange && selected !== null && (
            <div
              id={tooltipId}
              className="ops-timeline-tooltip"
              role="tooltip"
              style={{
                left: `clamp(0px, calc(${((selected + 0.5) / displayed.buckets.length) * 100}% - 140px), max(0px, calc(100% - 280px)))`,
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <span>
                {formatActivityTime(tooltipRange.start)} – {formatActivityTime(tooltipRange.end)}
              </span>
              {draft ? (
                <strong>{pointer.current ? "Release to filter" : "Enter to filter"}</strong>
              ) : (
                active && (
                  <strong>
                    {number(active.messageCount)}{" "}
                    {active.messageCount === 1 ? "message" : "messages"} ·{" "}
                    {number(active.participantCount)}{" "}
                    {active.participantCount === 1 ? "agent" : "agents"}
                  </strong>
                )
              )}
            </div>
          )}
        </div>
      </div>
      <div className="ops-timeline-axis" aria-hidden="true">
        <span>{formatActivityTime(displayed.windowStart)}</span>
        <span>{formatActivityTime(displayed.windowEnd)}</span>
      </div>
      <div className="ops-timeline-agents" aria-label="Sending agents in this window">
        <strong className="ops-timeline-metric">
          {number(displayed.participantCount)}{" "}
          <span>{displayed.participantCount === 1 ? "agent" : "agents"}</span>
        </strong>
        {displayed.senders.length > 0 && (
          <div className="ops-timeline-senders" aria-label="Top senders in this window">
            {displayed.senders.map((sender) => (
              <div
                key={sender.id}
                title={`${sender.name}: ${number(sender.messageCount)} messages`}
              >
                <AgentIcon type={sender.agentType} />
                <span>{sender.name}</span>
                <strong>{number(sender.messageCount)}</strong>
              </div>
            ))}
            {displayed.participantCount > displayed.senders.length && (
              <button
                className="ops-timeline-other"
                aria-haspopup="dialog"
                onClick={() => onShowSenders(displayed)}
              >
                +{number(displayed.participantCount - displayed.senders.length)} other{" "}
                {displayed.participantCount - displayed.senders.length === 1 ? "agent" : "agents"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
