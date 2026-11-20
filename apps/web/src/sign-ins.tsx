import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as S from "@talkto/api/sign-ins";
import { request, type Client } from "./api.js";
import { Dialog, Notice } from "./components.js";
import { useHuman, useServices } from "./session.js";
import "./server-settings.css";
import "./account.css";

/** Sign out one sign-in, or every copy of its app. */
export const signOut = (api: Client, id: S.SignInId, scope: S.SignOutScope) =>
  request(api.signIns.signOut({ params: { id }, payload: { scope } }));

/**
 * When the sign-in was last used. TalkTo writes it at most every 5 minutes, so anything within
 * 10 minutes reads as recent rather than as an exact time.
 */
export const formatActive = (value: string, now = new Date()) => {
  const ago = now.getTime() - new Date(value).getTime();
  if (ago < 600_000) return "Active in the last 10 minutes";
  const words = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (ago < 3_600_000) return `Active ${words.format(-Math.floor(ago / 60_000), "minute")}`;
  if (ago < 86_400_000) return `Active ${words.format(-Math.floor(ago / 3_600_000), "hour")}`;
  return `Active ${words.format(-Math.floor(ago / 86_400_000), "day")}`;
};
/** The day a sign-in started, with the year only when it is not this year. */
export const formatDay = (value: string, now = new Date()) => {
  const at = new Date(value);
  return at.getFullYear() === now.getFullYear()
    ? at.toLocaleDateString("en", { month: "short", day: "numeric" })
    : at.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
};
/** What a sign-out button says: one copy, or every copy of a shared app. */
export const signOutLabel = (item: S.SignIn, scope: S.SignOutScope) =>
  scope === "this" ? "Sign out" : `Sign out every ${item.app}`;
/** The program behind the requests, when it adds something to the app's name. */
const program = (item: S.SignIn) => {
  if (item.agent === null) return null;
  const known = S.agentName(item.agent);
  return known === item.app ? null : item.agent;
};

/** Every place an agent app signed in to the person's TalkTo, each with Sign out. */
export function SignedInComputers() {
  const { api } = useServices();
  const user = useHuman();
  const list = useQuery({
    queryKey: ["human", user.id, "sign-ins"],
    queryFn: ({ signal }) => request(api.signIns.list(), signal),
  });
  const [choice, setChoice] = useState<{
    readonly item: S.SignIn;
    readonly scope: S.SignOutScope;
  } | null>(null);
  return (
    <section className="ops-account" aria-labelledby="sign-ins-title">
      <div className="ops-page-bar">
        <h1 className="ops-page-title" id="sign-ins-title">
          Signed-in computers
        </h1>
      </div>
      <p className="ops-account-identity">
        Agent apps that signed in to TalkTo as <strong>{user.email}</strong>. Sign one out to stop
        every agent using it.
      </p>
      <Notice error={list.error} retry={() => void list.refetch()} />
      {list.isPending && <p role="status">Loading signed-in computers…</p>}
      {list.data && (
        <SignInList
          signIns={list.data.data}
          now={new Date()}
          choose={(item, scope) => setChoice({ item, scope })}
        />
      )}
      {choice && (
        <SignOutDialog item={choice.item} scope={choice.scope} close={() => setChoice(null)} />
      )}
    </section>
  );
}

/** The list, its empty state and the provider note; exported for rendering tests. */
export function SignInList({
  signIns,
  now,
  choose,
}: {
  readonly signIns: S.SignIns;
  readonly now: Date;
  readonly choose: (item: S.SignIn, scope: S.SignOutScope) => void;
}) {
  return (
    <section className="ops-sign-ins" aria-label="Signed-in computers">
      {signIns.provider === "unavailable" && (
        <p className="ops-account-blocked" role="note">
          TalkTo could not reach its sign-in provider just now. Sign-ins TalkTo has not seen yet may
          be missing. Reload to check again.
        </p>
      )}
      {signIns.items.length === 0 ? (
        <div className="ops-sign-ins-empty">
          <p>
            <strong>No computers are signed in.</strong>
          </p>
          <p>
            When an agent app connects to TalkTo and you approve its sign-in in the browser, it
            appears here.
          </p>
        </div>
      ) : (
        <ul>
          {signIns.items.map((item) => {
            const details = [item.place, program(item)].filter((value) => value !== null);
            return (
              <li key={item.id}>
                <div className="ops-sign-in">
                  <strong>{item.app}</strong>
                  <small>{details.length > 0 ? details.join(" · ") : "Place not recorded"}</small>
                  <small>
                    {item.lastActiveAt === null
                      ? "Not active since TalkTo began listing sign-ins"
                      : formatActive(item.lastActiveAt, now)}
                    {item.firstSignedInAt !== null &&
                      ` · First signed in ${formatDay(item.firstSignedInAt, now)}`}
                  </small>
                </div>
                <div className="ops-sign-in-actions">
                  {item.signOut.map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      className="ops-new"
                      onClick={() => choose(item, scope)}
                    >
                      {signOutLabel(item, scope)}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SignOutDialog({
  item,
  scope,
  close,
}: {
  readonly item: S.SignIn;
  readonly scope: S.SignOutScope;
  readonly close: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => signOut(api, item.id, scope),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["human", user.id, "sign-ins"] });
      close();
    },
  });
  return (
    <Dialog title={`${signOutLabel(item, scope)}?`} close={close}>
      <SignOutForm
        item={item}
        scope={scope}
        submit={() => mutation.mutate()}
        pending={mutation.isPending}
        error={mutation.error}
        close={close}
      />
    </Dialog>
  );
}

/** Stateless confirmation; exported so its wording can be rendered in tests. */
export function SignOutForm({
  item,
  scope,
  submit,
  pending,
  error,
  close,
}: {
  readonly item: S.SignIn;
  readonly scope: S.SignOutScope;
  readonly submit: () => void;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly close: () => void;
}) {
  return (
    <form
      className="ops-delete-confirmation"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) submit();
      }}
    >
      <p>
        {scope === "this"
          ? "Every agent using this sign-in stops until someone signs in there again."
          : `Every agent using ${item.app} on any computer stops until someone signs in there again.`}
      </p>
      {scope === "this" && item.shared && (
        <p>Other computers signed in to {item.app} keep working.</p>
      )}
      <Notice error={error} />
      {pending && <p role="status">Signing out…</p>}
      <div className="ops-delete-actions">
        <button type="button" className="ops-new" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="ops-danger" disabled={pending} data-autofocus>
          {error ? "Try again" : signOutLabel(item, scope)}
        </button>
      </div>
    </form>
  );
}
