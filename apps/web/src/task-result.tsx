import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type * as M from "@talkto/api/models";
import type * as T from "@talkto/api/tasks";
import { request } from "./api.js";
import { Notice } from "./components.js";
import { formatShareSize } from "./message-dialogue.js";
import { formatFeedTime } from "./format.js";
import { useServices } from "./session.js";
import {
  fileExpiry,
  fileFacts,
  linkHost,
  linkKind,
  linkText,
  resultCode,
  shortHash,
  shortSha,
} from "./board-model.js";
import "./task-result.css";

/*
  The task page's Result panel (docs/swarm-task-results-scope.md, 6.1): the summary, the files a
  claimer attached with Download, the code handed over (base → head, branches, commits) and other
  links. A failed task's panel is titled Reason. Every link shows its host name beside its label,
  opens in a new tab and never sends a referrer; a commit or branch without a URL is copyable text.
*/

/** A copy control for one exact value, such as a full commit SHA. */
function Copy({ value, label }: { readonly value: string; readonly label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "select">("idle");
  return (
    <button
      type="button"
      className="text-button task-result-copy"
      aria-label={label}
      title={value}
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setState("copied"),
          () => setState("select"),
        );
      }}
    >
      {state === "copied" ? "Copied" : state === "select" ? "Select to copy" : "Copy"}
    </button>
  );
}

/** One commit as code: its short SHA, the full one on hover, and a copy control. */
function Commit({ sha, role }: { readonly sha: string; readonly role?: string }) {
  return (
    <span className="task-result-commit">
      {role !== undefined && <span className="task-result-role">{role}</span>}
      <code title={sha}>{shortSha(sha)}</code>
      <Copy value={sha} label={`Copy the full ${role ?? "commit"} SHA ${sha}`} />
    </span>
  );
}

/** One link: its kind, what it says, and the host it goes to. */
function LinkRow({ link }: { readonly link: T.ResultLink }) {
  const text = linkText(link);
  return (
    <li className="task-result-link">
      <span className="task-result-tag">{linkKind(link.kind)}</span>
      <span className="task-result-text">
        {link.url === undefined ? (
          <code>{text}</code>
        ) : (
          <a href={link.url} target="_blank" rel="noopener noreferrer nofollow" title={link.url}>
            {text}
          </a>
        )}
        {link.sha !== undefined && (
          <Copy value={link.sha} label={`Copy the full SHA ${link.sha}`} />
        )}
        {link.sha === undefined && link.name !== undefined && (
          <Copy value={link.name} label={`Copy the branch name ${link.name}`} />
        )}
      </span>
      {link.url !== undefined && (
        <span className="task-result-host">
          {linkHost(link.url)}
          <span aria-hidden="true"> ↗</span>
        </span>
      )}
    </li>
  );
}

/** The task's result or reason, above its thread. */
export function TaskResult({
  serverId,
  outcome,
  by,
  refresh,
}: {
  readonly serverId: M.ServerId;
  readonly outcome: NonNullable<T.Task["outcome"]> & { readonly summary: T.Summary };
  /** The agent that finished it, as the page names agents. */
  readonly by: string | undefined;
  /** Read the task again, so a file that expired while the page was open shows it. */
  readonly refresh: () => void;
}) {
  const { api } = useServices();
  const heading = useId();
  const download = useMutation({
    mutationFn: (transferId: M.TransferId) =>
      request(api.server.downloadTransfer({ params: { serverId, transferId } })),
    // The link names the file and is an attachment, so the page stays where it is.
    onSuccess: (link) => window.location.assign(link.data.url),
    onError: refresh,
  });
  const files = outcome.files ?? [];
  const { base, head, code, other } = resultCode(outcome.links ?? []);
  const now = new Date();
  return (
    <section className="board-panel task-result" aria-labelledby={heading}>
      <div className="task-result-head">
        <h3 id={heading}>{outcome.kind === "completed" ? "Result" : "Reason"}</h3>
        <span>
          {by === undefined ? "" : `by ${by}, `}
          <time dateTime={outcome.at}>{formatFeedTime(outcome.at)}</time>
        </span>
      </div>
      <p className="task-result-summary">{outcome.summary}</p>
      <Notice error={download.error} />
      {files.length > 0 && (
        <div className="task-result-part">
          <h4>Files</h4>
          <ul className="task-result-files">
            {files.map((file) => {
              const available = file.state === "available" && new Date(file.expiresAt) > now;
              const pending = download.isPending && download.variables === file.id;
              return (
                <li
                  key={file.id}
                  data-kind={file.kind}
                  data-state={available ? "available" : "expired"}
                >
                  <span className="ops-share-mark" aria-hidden="true" />
                  <span className="task-result-file">
                    <span className="task-result-name">{file.name}</span>
                    <span className="task-result-meta">
                      <span>{fileFacts(file, formatShareSize(file.bytes))}</span>
                      <span title={file.sha256}>sha256 {shortHash(file.sha256)}</span>
                      <span>{fileExpiry(file, now)}</span>
                    </span>
                  </span>
                  {available && (
                    <button
                      type="button"
                      className="ops-new"
                      disabled={pending}
                      aria-label={`Download ${file.name}`}
                      onClick={() => download.mutate(file.id)}
                    >
                      {pending ? "Preparing…" : "Download"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {(base !== undefined || head !== undefined || code.length > 0) && (
        <div className="task-result-part">
          <h4>Code</h4>
          <ul className="task-result-links">
            {(base !== undefined || head !== undefined) && (
              <li className="task-result-range">
                <span className="task-result-tag">Commits</span>
                <span className="task-result-text">
                  {base?.sha !== undefined && <Commit sha={base.sha} role="base" />}
                  {base !== undefined && head !== undefined && (
                    <span className="task-result-arrow" aria-label="to">
                      →
                    </span>
                  )}
                  {head?.sha !== undefined && <Commit sha={head.sha} role="head" />}
                </span>
              </li>
            )}
            {code.map((link, index) => (
              <LinkRow key={`${link.kind}:${index}`} link={link} />
            ))}
          </ul>
        </div>
      )}
      {other.length > 0 && (
        <div className="task-result-part">
          <h4>Links</h4>
          <ul className="task-result-links">
            {other.map((link, index) => (
              <LinkRow key={`${link.kind}:${index}`} link={link} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
