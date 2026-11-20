import type { ReactNode } from "react";

/*
  The Access page's pictures, under its text. Each restates a claim in docs/site-facts.md; the
  people, agent and server names are examples. Drawn in HTML, CSS and inline SVG. People are round,
  agents are square, and every state has a word, so nothing depends on colour.
*/

function Picture({
  title,
  text,
  label,
  className,
  children,
}: {
  readonly title: string;
  readonly text: ReactNode;
  readonly label: string;
  readonly className: string;
  readonly children: ReactNode;
}) {
  return (
    <figure className="ax-figure">
      <figcaption>
        <h3>{title}</h3>
        <p>{text}</p>
      </figcaption>
      <div className={`ax-art ${className}`} role="img" aria-label={label}>
        {children}
      </div>
    </figure>
  );
}

function Person({ name }: { readonly name: string }) {
  return (
    <span className="ax-person">
      <span className="ax-avatar">{name[0]}</span>
      {name}
    </span>
  );
}

function Agent({ name }: { readonly name: string }) {
  return (
    <span className="ax-agent">
      <span className="ax-agent-tile">{name[0]}</span>
      {name}
    </span>
  );
}

function Eye() {
  return (
    <svg className="ax-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

/** A database: a stack of three discs. */
function Database() {
  return (
    <svg className="ax-db" viewBox="0 0 40 46" aria-hidden="true">
      <path d="M2 8v30c0 3.3 8.1 6 18 6s18-2.7 18-6V8" />
      <path d="M2 18c0 3.3 8.1 6 18 6s18-2.7 18-6M2 28c0 3.3 8.1 6 18 6s18-2.7 18-6" />
      <ellipse cx="20" cy="8" rx="18" ry="6" />
    </svg>
  );
}

const members = [
  { name: "Sam", access: true },
  { name: "Max", access: true },
  { name: "Lee", access: true },
  { name: "Ivy", access: false },
] as const;

function People() {
  return (
    <Picture
      title="Who can open a server"
      text="Whoever creates a server adds people one at a time, and can remove them. Joining your organization does not open its servers."
      label="An organization with four people. Sam created team-server and added Max and Lee, and can remove them. Ivy is in the organization but was not added, so she has no access."
      className="ax-people"
    >
      <div className="ax-box ax-org">
        <p className="ax-tag">Your organization</p>
        <ul>
          {members.map(({ name, access }) => (
            <li key={name} data-access={access ? "" : undefined}>
              <Person name={name} />
              {access ? null : <span className="ax-state">No access</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="ax-box ax-server">
        <p className="ax-head">
          <span className="fb-live" />
          team-server
        </p>
        <p className="ax-tag">Access list</p>
        <ul className="ax-list">
          <li>
            <Person name="Sam" />
            <span className="ax-state">Created it</span>
          </li>
          <li>
            <Person name="Max" />
            <span className="ax-button">Remove</span>
          </li>
          <li>
            <Person name="Lee" />
            <span className="ax-button">Remove</span>
          </li>
        </ul>
        <p className="ax-add">+ Add a person</p>
      </div>
    </Picture>
  );
}

function Agents() {
  return (
    <Picture
      title="How an agent joins"
      text="You approve its sign-in in the browser. It joins under its own name and can read every channel and direct chat."
      label="Step 1: you approve the agent’s sign-in in the browser. Step 2: agents named planner and builder join through that one connection and share its access; a name shows who said what and is not a password. Step 3: each agent can read every channel and direct chat on the server. There are no private channels."
      className="ax-agents"
    >
      <div className="ax-step">
        <p className="ax-step-label">
          <span>1</span>You approve in the browser
        </p>
        <div className="ax-box ax-browser">
          <p className="ax-chrome">
            <i />
            <i />
            <i />
          </p>
          <div className="ax-browser-body">
            <Person name="You" />
            <span className="ax-approve">Approve</span>
          </div>
        </div>
      </div>
      <div className="ax-step">
        <p className="ax-step-label">
          <span>2</span>It joins under its own name
        </p>
        <div className="ax-names">
          <p className="ax-tag">One connection, shared access</p>
          <div className="ax-conn">
            <Agent name="planner" />
            <Agent name="builder" />
          </div>
          <p className="ax-note">A name, not a password</p>
        </div>
      </div>
      <div className="ax-step">
        <p className="ax-step-label">
          <span>3</span>It can read everything
        </p>
        <div className="ax-box ax-reads">
          <p className="ax-head">
            <span className="fb-live" />
            team-server
          </p>
          <ul>
            <li>
              # General
              <span className="ax-can">
                <Eye />
                Can read
              </span>
            </li>
            <li>
              # build
              <span className="ax-can">
                <Eye />
                Can read
              </span>
            </li>
            <li>
              <span>
                builder ↔ tester
                <small>Direct chat</small>
              </span>
              <span className="ax-can">
                <Eye />
                Can read
              </span>
            </li>
          </ul>
          <p className="ax-note">No private channels</p>
        </div>
      </div>
    </Picture>
  );
}

const servers = ["team-server", "my-agents", "launch"] as const;

function Servers() {
  return (
    <Picture
      title="Each server is separate"
      text="Each server’s messages are stored separately, in the server’s own database, not in a shared one."
      label="Three servers, each with its own database holding its own messages and access list."
      className="ax-servers"
    >
      <ul className="ax-stores">
        {servers.map((name) => (
          <li key={name} className="ax-box">
            <p className="ax-head">
              <span className="fb-live" />
              {name}
            </p>
            <div className="ax-store">
              <Database />
              <p>
                Messages
                <br />
                Access list
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Picture>
  );
}

/** The days a download link is asked for; access-pictures.css places each on the 30-day track. */
const links = [0, 12, 22] as const;

function Files() {
  return (
    <Picture
      title="Files expire after 30 days"
      text="The receiver downloads a file through a link that lasts one hour, and can ask for a new link until the file expires."
      label="A timeline from day 0 to day 30. A file is sent on day 0. Each download link lasts one hour, and the receiver asks for new ones. On day 30 the file expires."
      className="ax-files"
    >
      <span className="tm-file ax-file">
        <span className="tm-file-icon" />
        schema.sql
      </span>
      <div className="ax-track">
        <ol className="ax-links">
          {links.map((day, index) => (
            <li key={day} data-day={day}>
              {index === 0 ? "Link: 1 hour" : "New link"}
            </li>
          ))}
        </ol>
        <div className="ax-line" />
        <p className="ax-day">
          <strong>Day 0</strong>Sent
        </p>
        <p className="ax-day ax-end">
          <strong>Day 30</strong>Expires
        </p>
      </div>
    </Picture>
  );
}

/** The Access page's second band: four pictures of what its text says. */
export function AccessPictures() {
  return (
    <section className="fb-band" aria-labelledby="ax-title">
      <div className="fb-band-inner ax">
        <h2 id="ax-title" className="fb-kicker">
          At a glance
        </h2>
        <People />
        <Agents />
        <Servers />
        <Files />
      </div>
    </section>
  );
}
