/**
 * Dev-only "break the UI" data switch. Compiled in only when the build sets VITE_BREAK_UI=1.
 * It swaps read responses at the fetch boundary, so every value still passes the app's schemas.
 * Values use the real limits from packages/api/src/models.ts: names are ASCII up to 64 characters,
 * server names 100 UTF-8 bytes, message bodies 16,384 UTF-8 bytes.
 */
const modes = [
  ["demo", "Demo"],
  ["worst", "Worst case"],
  ["empty", "Empty"],
  ["one", "One"],
  ["huge", "1,000 rows"],
  ["readonly", "Read-only"],
  ["error", "Errors"],
] as const;
type Mode = (typeof modes)[number][0];

const storageKey = "talkto-break-ui";
const paragraph =
  "The billing rewrite touches the checkout, the renewal path and the webhook handler, so I reran the whole suite and read each failure before calling anything flaky. ";

/** A real agent report sits right at the 16,384-byte message limit. */
const longReport = `Full review notes follow.\n\n${paragraph.repeat(98)}`.slice(0, 16_300);

const names = [
  "release-platform-engineering-review-agent-for-q4-billing-rewrite",
  "Jo",
  "J",
  "Konstantin_Oberhauser-Wettstein",
  "release-platform-engineering-review-agent-for-q4-billing-rework",
  "dana",
  "codex_worktree_dashboard_concurrent_load_verification_runner_07",
  "Cedar",
];
const agentTypes = [
  "claude-code",
  "our-internal-agent-harness-build-2026-q4-with-custom-tooling-v12",
  "codex",
  "",
];
const channelNames = [
  "general",
  "release-planning-and-platform-infrastructure-coordination-q4-26",
  "q",
  "customer_feedback_from_enterprise_onboarding_sessions_2026_q4",
  "Build",
];
const serverNames = [
  "Northwind Industries Holdings — Platform Infrastructure & Reliability Engineering (EMEA)",
  "J",
  "王秀英的产品工作室服务器",
  "Benachrichtigungseinstellungenverwaltungsserverproduktionsumgebungwiederherstellung2026",
  "نور الهدى عبد الرحمن",
  "🦊 Fox",
  "Đặng Thị Ngọc Hân — ทดสอบภาษาไทย",
  "<script>alert(1)</script> &amp; **bold**",
];
const people = [
  ["Aleksandra", "Wiśniewska-Kowalczyk", "aleksandra@example.com"],
  [null, null, "bartholomew.fitzgerald@northwind-industries-holdings.example.com"],
  ["Jo", null, "a@b.co"],
  ["Christopher Alexander", "Montgomery III", "first.last+billing-notifications@example.com"],
  ["王", "秀英", "ops@sub.department.region.example.co.uk"],
  ["نور الهدى", "عبد الرحمن", "noor@example.org"],
] as const;
const invitationEmails = [
  "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
  "a@b.co",
  "first.last+billing-notifications@example.com",
];
const invitationStates = ["pending", "expired", "accepted", "revoked"];
const counts = [1284, 0, 1, 1_000_000, 12];
const shares = [
  {
    path: "packages/design/release-candidates/2026-q4/very/deeply/nested/folder/structure/assets/Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf",
    ref: "feature/a-very-long-branch-name-for-the-release-candidate-with-the-ticket-number-TT-48211",
    bytes: 48_211_968_000,
  },
  { path: "a.md", ref: "main", bytes: 0 },
  {
    path: "IMG_20250914_183022_HDR_portrait_edited_edited_edited_edited_edited_edited_edited.HEIC",
    ref: "v1",
    bytes: 1023,
  },
];
const bodies = [
  `## Review of the billing change

**Result:** two problems, one blocker.

1. \`checkout.ts\` retries *after* the session expires.
2. The webhook handler drops \`past_due\`.

| File | Lines | Status |
| --- | --- | --- |
| apps/server/src/billing/checkout.ts | 212-240 | blocker |
| apps/web/src/billing.tsx | 88 | fine |

\`\`\`ts
if (session.expiresAt < now) {
  return yield* new CheckoutExpired({ sessionId: session.id, expiresAt: session.expiresAt, observedAt: now });
}
\`\`\`

See [the run](https://example.com/runs/1284) and tell me if you want me to fix it → then I'll re-run.`,
  "https://example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a/revisions/0123456789abcdef0123456789abcdef/comments?tab=comments&filter=unresolved&sort=newest&author=release-platform-engineering-review-agent",
  "k",
  `TypeError: Cannot read properties of undefined (reading 'expiresAt')
    at resolveCheckoutSession (/workspace/talkto/.claude/worktrees/billing/apps/server/src/billing/checkout.ts:238:41)
    at processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async /workspace/talkto/.claude/worktrees/billing/node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/internal/core.js:1284:12`,
  longReport,
  "<script>alert(1)</script> &amp; **bold** and a real <b>tag</b> @Atlas please look",
  "👩🏽‍💻 shipped it 🚀🚀🚀 🦊 — ready → review ← done ↗ see above ↔ both ✓",
  "تم الانتهاء من مراجعة التغييرات. The API is ready to test، يرجى المتابعة → الخطوة التالية.",
  "这条消息没有任何空格所以浏览器只能在字符之间换行我们需要确认它在窄屏幕上也能正常显示并且不会把布局撑开也不会被裁切这是一条很长的中文消息用来测试换行行为",
  "Đặng Thị Ngọc Hân đã kiểm tra. ภาษาไทยที่มีสระซ้อนกันอยู่ด้านบนและด้านล่าง ผู้ใช้ทดสอบ",
  "\n\n\n    indented by four spaces\n\n\n\n\n\n\n\n\tthen a tab, then a lot of blank lines\n\n\n\n\n\n\n",
  `{"event":"checkout.session.completed","sessionId":"cs_test_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6","amount":12345678.9,"retry":null}`,
  "9f3c2ab4d1e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0",
];
const longPath =
  "/Users/aleksandra.wisniewska-kowalczyk/Documents/Work/Northwind/platform-infrastructure/repositories/talkto/.claude/worktrees/codex-dashboard-concurrent-load-verification/apps/web/src";
const longNote = `Registered to review the billing rewrite and coordinate the release.\n\n${paragraph.repeat(5)}`;
const longDescription = `Everything about the Q4 release.\nOwners: platform.\n\n${paragraph.repeat(5)}`;

const selectedMode = (): Mode => {
  const wanted =
    new URLSearchParams(location.search).get("data") ?? sessionStorage.getItem(storageKey);
  return modes.find(([id]) => id === wanted)?.[0] ?? "demo";
};

/** The first entity of each kind gets the first value, so the failures spread across visible rows. */
const assigned = new Map<string, number>();
function pick<T>(kind: string, id: string, values: ReadonlyArray<T>, fallback: T): T {
  const key = `${kind}:${id}`;
  const next =
    assigned.get(key) ?? [...assigned.keys()].filter((k) => k.startsWith(`${kind}:`)).length;
  assigned.set(key, next);
  return values[next % values.length] ?? fallback;
}

const hour = 3_600_000;
function worstTime(sequence: number) {
  // Early messages span three years, later ones are minutes apart; every ninth lands just after midnight.
  const now = Date.now();
  const age = sequence < 60 ? (60 - sequence) * 18 * 24 * hour : (1300 - sequence) * 37 * 60_000;
  const time = new Date(now - Math.max(age, 60_000));
  if (sequence % 9 === 0) time.setHours(0, 0, 30, 0);
  return time.toISOString();
}

/** A JSON.parse reviver visits children first, so each record is rewritten after its fields. */
function reviver(mode: Mode) {
  return (key: string, value: ReturnType<typeof JSON.parse>) => {
    if (mode === "demo" || value === null) return value;
    if (Array.isArray(value)) {
      if (!["items", "servers", "channels", "participants", "senders"].includes(key)) return value;
      if (mode === "empty") return [];
      if (mode === "one") return value.slice(0, 1);
      return value;
    }
    if (key === "nextCursor" && (mode === "empty" || mode === "one")) return null;
    if (["lastMessageAt", "latestMessage", "firstMessageAt"].includes(key) && mode === "empty")
      return null;
    if (key === "permissions" && mode === "readonly")
      return Object.fromEntries(
        Object.keys(value).map((name) => [
          name,
          name === "readMessages" || name === "createAccount",
        ]),
      );
    if (Object(value) !== value) return value;
    const scale = (name: string, id: string) =>
      name in value
        ? {
            [name]:
              mode === "empty"
                ? 0
                : mode === "one"
                  ? 1
                  : mode === "huge"
                    ? 1_000_000
                    : mode === "worst"
                      ? pick(name, id, counts, 0)
                      : value[name],
          }
        : undefined;
    const id = String(value.id ?? value.userId ?? value.start ?? key);
    const numbers = {
      ...scale("participantCount", id),
      ...scale("channelCount", id),
      ...scale("directConversationCount", id),
      ...scale("messageCount", id),
      ...scale("serverCount", id),
    };
    const worst = mode === "worst";
    if ("agentType" in value && "name" in value)
      return {
        ...value,
        ...numbers,
        ...(worst && {
          name: pick("agent", id, names, value.name),
          agentType: pick("agentType", id, agentTypes, value.agentType) || "unknown",
          workingDirectory: pick("path", id, [longPath, null], null),
          joinedNote: pick("note", id, [longNote, null, "k"], null),
        }),
      };
    if (value.kind === "channel")
      return {
        ...value,
        ...numbers,
        ...(worst && {
          name: value.isGeneral ? "general" : pick("channel", id, channelNames, value.name),
          description: pick("description", id, [longDescription, null], null),
        }),
      };
    if ("sequence" in value && "body" in value) {
      const shared =
        worst && value.share
          ? { share: { ...value.share, ...pick("share", id, shares, value.share) } }
          : {};
      return {
        ...value,
        ...shared,
        ...(worst && {
          body: bodies[value.sequence % bodies.length],
          createdAt: worstTime(value.sequence),
        }),
      };
    }
    if ("email" in value && "state" in value)
      return {
        ...value,
        ...(worst && {
          email: pick("invite", id, invitationEmails, value.email),
          state: pick("inviteState", id, invitationStates, value.state),
        }),
      };
    if ("email" in value && "firstName" in value) {
      const person = pick("person", id, people, people[0]);
      return {
        ...value,
        ...(worst && { firstName: person[0], lastName: person[1], email: person[2] }),
      };
    }
    if ("generalConversationId" in value || ("status" in value && "accountId" in value))
      return {
        ...value,
        ...numbers,
        ...(worst && { name: pick("server", id, serverNames, value.name) }),
      };
    if ("serverId" in value && "serverName" in value)
      return {
        ...value,
        ...(worst && {
          serverName: pick("server", String(value.serverId), serverNames, value.serverName),
        }),
      };
    if ("organizationId" in value && "name" in value)
      return {
        ...value,
        ...numbers,
        ...(worst && { name: pick("account", id, serverNames, value.name) }),
      };
    if ("allowance" in value && "usageUpperBound" in value && (worst || mode === "huge"))
      return {
        ...value,
        status: "overdraft",
        periodStart: new Date(Date.now() - 300 * hour).toISOString(),
        periodEnd: new Date(Date.now() + 300 * hour).toISOString(),
        allowance: 1_000_000,
        overdraft: 100_000,
        used: 1_420_000,
        outstanding: 12_345,
        usageUpperBound: 1_432_345,
      };
    return { ...value, ...numbers };
  };
}

async function rewrite(mode: Mode, response: Response) {
  if (mode === "demo" || !response.ok) return response;
  if (!response.headers.get("content-type")?.includes("json")) return response;
  const text = await response.text();
  return new Response(JSON.stringify(JSON.parse(text, reviver(mode))), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function outage() {
  return new Response(
    JSON.stringify({
      error: {
        code: "storage_unavailable",
        message: "Temporary test outage. Message storage did not answer in time, try again soon.",
      },
      meta: {
        requestId: "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f",
        serverTime: new Date().toISOString(),
        instructions: { url: "https://example.com/instructions", text: "Test instructions" },
      },
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

function renderToggle(current: Mode) {
  const bar = document.createElement("div");
  bar.id = "break-ui-toggle";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Dev data set");
  bar.style.cssText =
    "position:fixed;bottom:8px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;gap:2px;padding:2px;background:#ddd;border-radius:8px;font:11px system-ui,sans-serif;color:#222;max-width:calc(100vw - 8px);overflow-x:auto";
  for (const [id, label] of modes) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = `border:0;border-radius:6px;padding:3px 7px;white-space:nowrap;cursor:pointer;color:#222;background:${id === current ? "#fff" : "transparent"}`;
    button.onclick = () => {
      sessionStorage.setItem(storageKey, id);
      const url = new URL(location.href);
      url.searchParams.set("data", id);
      location.assign(url);
    };
    bar.append(button);
  }
  document.body.append(bar);
}

/** Install the switch before the application issues its first request. */
export function installBreakUi() {
  const mode = selectedMode();
  sessionStorage.setItem(storageKey, mode);
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const read = method === "GET" && url.origin === location.origin;
    const data = read && url.pathname.startsWith("/v1/");
    if (data && mode === "error" && url.pathname !== "/v1/me") return outage();
    const response = await original(input, init);
    return data ? rewrite(mode, response) : response;
  };
  renderToggle(mode);
}
