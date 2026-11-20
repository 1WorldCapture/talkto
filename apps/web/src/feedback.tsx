import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Schema } from "effect";
import * as F from "@talkto/api/feedback";
import type * as P from "@talkto/api/platform";
import { ApiError, request } from "./api.js";
import { Dialog, Notice } from "./components.js";
import { useServices } from "./session.js";
import "./feedback.css";

/*
  The Feedback button's dialog (docs/feedback.md). One message goes to TalkTo's D1 with the page's
  path (never its query string), the web build and, from the request, the browser's User-Agent.
*/

const labels = {
  feedback: "What should we know?",
  bug: "What happened?",
} as const satisfies Record<F.FeedbackKind, string>;

/** The web build, when it is a value the API accepts. */
const version = Schema.decodeUnknownOption(F.AppVersion)(__TALKTO_WEB_RELEASE__);

/** The person's draft and the request key of its last attempt, so a retry is one message. */
interface Attempt {
  readonly kind: F.FeedbackKind;
  readonly message: string;
  readonly requestKey: string;
}

/**
 * Feedback or a bug report in the existing Dialog. `accountId` is the organization on screen, if
 * any; the server keeps it only when the person can open it.
 */
export function FeedbackDialog({
  accountId,
  close,
}: {
  readonly accountId?: P.AccountId | undefined;
  readonly close: () => void;
}) {
  const { api } = useServices();
  const [kind, setKind] = useState<F.FeedbackKind>("feedback");
  const [message, setMessage] = useState("");
  const [validation, setValidation] = useState<Error | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const fieldId = useId();
  const noteId = useId();
  const action = useMutation({
    mutationFn: (payload: F.SendFeedback) => request(api.feedback.send({ payload })),
  });
  const limited = action.error instanceof ApiError && action.error.code === "feedback_limited";
  const remaining = F.messageLimit - message.length;
  return (
    <Dialog title="Feedback and bugs" className="feedback-dialog" close={close}>
      {action.isSuccess ? (
        <Sent close={close} />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (action.isPending) return;
            // The same words keep the same key, so a retry after a lost answer stores one message.
            const previous = attempt.current;
            const requestKey =
              previous !== null && previous.kind === kind && previous.message === message
                ? previous.requestKey
                : crypto.randomUUID();
            // The path only: a query string or fragment can hold private values.
            const base = { kind, message, page: window.location.pathname, requestKey };
            const versioned =
              version._tag === "Some" ? { ...base, appVersion: version.value } : base;
            const draft = accountId === undefined ? versioned : { ...versioned, accountId };
            const parsed = Schema.decodeUnknownResult(F.SendFeedback)(draft);
            if (parsed._tag === "Failure") {
              setValidation(
                new ApiError(
                  "invalid_input",
                  message.trim().length === 0
                    ? "Write a message first."
                    : "This message could not be sent from this page.",
                ),
              );
              return;
            }
            setValidation(null);
            attempt.current = { kind, message, requestKey };
            action.mutate(parsed.success);
          }}
        >
          <fieldset className="feedback-kind">
            <legend className="sr-only">Type</legend>
            {(["feedback", "bug"] as const).map((value) => (
              <label key={value} className={kind === value ? "is-selected" : undefined}>
                <input
                  type="radio"
                  name="kind"
                  value={value}
                  checked={kind === value}
                  onChange={() => setKind(value)}
                />
                {value === "bug" ? "Bug" : "Feedback"}
              </label>
            ))}
          </fieldset>
          <label htmlFor={fieldId}>{labels[kind]}</label>
          <textarea
            id={fieldId}
            name="message"
            rows={6}
            required
            maxLength={F.messageLimit}
            value={message}
            aria-describedby={noteId}
            data-autofocus
            onChange={(event) => setMessage(event.target.value)}
          />
          <p id={noteId} className="feedback-note">
            Sent with this page’s path, the app version and your browser details.
            {remaining <= 500 && ` ${remaining.toLocaleString()} characters left.`}
          </p>
          <Notice error={validation ?? action.error} />
          <div className="form-actions">
            <button className="btn" disabled={action.isPending || limited}>
              {action.isPending ? "Sending…" : "Send"}
            </button>
            <button type="button" className="text-button" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** The thank-you, with focus on its only action so the keyboard is never left behind. */
function Sent({ close }: { readonly close: () => void }) {
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => done.current?.focus(), []);
  return (
    <>
      <p className="feedback-sent" role="status">
        Sent. We read every message.
      </p>
      <div className="form-actions">
        <button ref={done} className="btn" onClick={close}>
          Done
        </button>
      </div>
    </>
  );
}
