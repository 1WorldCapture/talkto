import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  The dashboard's Files tab: every transfer on a server, newest first, for anyone with access to
  the server, and a short-lived download link for a person. Agents' tools are covered in
  transfers.test.mjs; this file covers the person-facing listing and download routes.
*/

const sha = "b".repeat(64);

/** One server with two agents, and helpers to send transfers and call the person routes. */
const setup = async (t, options = {}) => {
  const x = await start(t, { transfers: true, ...options });
  const account = await x.account();
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const credential = await x.mcpToken(account.organizationId);
  const register = async (name) =>
    (
      await x.mcp(credential, "register_participant", {
        serverId: server.id,
        name,
        agentType: "claude-code",
        requestKey: randomUUID(),
      })
    ).data;
  const sender = await register("sender");
  const receiver = (await register("receiver")).item.id;
  const general = sender.generalConversationId;
  const senderId = sender.item.id;
  const call = (name, args, error = false) =>
    x.mcp(credential, name, { serverId: server.id, ...args }, error);
  const upload = async (transferId, part, bytes) => {
    const key = `r30/${server.id}/${transferId}/${part}`;
    const response = await x.control(
      `transfer-object?key=${encodeURIComponent(key)}&bytes=${bytes}`,
    );
    assert.equal(response.status, 200);
  };
  /** Prepare only: the sender never posts the offer. */
  const prepare = async (args = {}) =>
    (
      await call("prepare_transfer", {
        participantId: senderId,
        requestKey: randomUUID(),
        name: "report.pdf",
        kind: "file",
        bytes: 16,
        sha256: sha,
        ...args,
      })
    ).data;
  /** Prepare, upload and post an offer; `target` defaults to General. */
  const send = async (args = {}, target = { kind: "conversation", conversationId: general }) => {
    const prepared = await prepare(args);
    await upload(prepared.transferId, "payload", args.bytes ?? 16);
    if (args.kind === "folder") await upload(prepared.transferId, "manifest", args.manifestBytes);
    const sent = await call("complete_transfer", {
      participantId: senderId,
      requestKey: randomUUID(),
      target,
      transferId: prepared.transferId,
      body: "Here it is.",
    });
    return sent.data.item;
  };
  /** The whole envelope of a person route, so tests read `included` beside `data`. */
  const person = async (method, path, status = 200, user = "user_alice") => {
    const response = await x.raw(`${root}${path}`, {
      method,
      headers: { authorization: `Bearer ${await x.token(user)}` },
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const list = (query = "", status = 200, user = "user_alice") =>
    person("GET", `/files/transfers${query}`, status, user);
  const download = (transferId, status = 200, user = "user_alice") =>
    person("POST", `/files/transfers/${transferId}/download`, status, user);
  return {
    x,
    account,
    server,
    root,
    general,
    senderId,
    receiver,
    call,
    prepare,
    send,
    list,
    download,
  };
};

test("the listing names each sent file's sender and conversation, channels and direct chats", async (t) => {
  const s = await setup(t);
  assert.deepEqual((await s.list()).data, { items: [], nextCursor: null });

  const channel = await s.send({ name: "report.pdf", bytes: 16 });
  const direct = await s.send(
    { name: "site", kind: "folder", bytes: 32, fileCount: 3, manifestBytes: 24 },
    { kind: "direct", recipientId: s.receiver },
  );
  const page = await s.list();
  assert.equal(page.data.nextCursor, null);
  assert.equal(page.data.items.length, 2);
  const [folder, file] = [direct, channel].map((message) =>
    page.data.items.find((item) => item.id === message.transfer.id),
  );
  assert.deepEqual(
    { ...file, createdAt: undefined },
    {
      id: channel.transfer.id,
      name: "report.pdf",
      kind: "file",
      bytes: 16,
      fileCount: null,
      senderId: s.senderId,
      conversationId: s.general,
      messageId: channel.id,
      messageSequence: channel.sequence,
      createdAt: undefined,
      expiresAt: channel.transfer.expiresAt,
      state: "available",
    },
  );
  assert.equal(
    Date.parse(file.expiresAt) - Date.parse(file.createdAt),
    30 * 24 * 60 * 60 * 1000,
    "kept for 30 days",
  );
  // Direct chats are readable by everyone on the server, so their files are listed too.
  assert.equal(folder.kind, "folder");
  assert.equal(folder.fileCount, 3);
  assert.equal(folder.conversationId, direct.conversationId);
  assert.equal(folder.state, "available");
  const chat = page.included.conversations.find((item) => item.id === direct.conversationId);
  assert.equal(chat.kind, "direct");
  assert.deepEqual(chat.participantIds.toSorted(), [s.senderId, s.receiver].toSorted());
  assert.ok(page.included.conversations.some((item) => item.id === s.general));
  const names = page.included.participants.map((participant) => participant.name).toSorted();
  assert.deepEqual(names, ["receiver", "sender"], "the sender and the chat's members are named");
});

test("an unsent transfer is incomplete and a lapsed one is expired", async (t) => {
  const s = await setup(t);
  const sent = await s.send();
  const prepared = await s.prepare({ name: "draft.md" });
  const before = await s.list();
  const incomplete = before.data.items.find((item) => item.id === prepared.transferId);
  assert.equal(incomplete.state, "incomplete");
  assert.equal(incomplete.conversationId, null);
  assert.equal(incomplete.messageId, null);
  assert.equal(incomplete.messageSequence, null);
  await s.download(prepared.transferId, 404).then(({ error }) => {
    assert.equal(error.code, "transfer_not_found", "nothing was sent, so nothing downloads");
  });

  assert.equal((await s.x.control(`transfers-expired?server=${s.server.id}`)).status, 200);
  const after = await s.list();
  const states = Object.fromEntries(after.data.items.map((item) => [item.id, item.state]));
  assert.deepEqual(states, {
    [sent.transfer.id]: "expired",
    [prepared.transferId]: "incomplete",
  });
  const expired = await s.download(sent.transfer.id, 409);
  assert.equal(expired.error.code, "transfer_expired");
});

test("pages run newest first with a bounded size and a continuation bound to the server", async (t) => {
  const s = await setup(t);
  const ids = [];
  for (let n = 0; n < 5; n++) ids.push((await s.send({ name: `file-${n}.txt` })).transfer.id);
  const seen = [];
  let page = await s.list("?limit=2");
  assert.equal(page.data.items.length, 2);
  seen.push(...page.data.items);
  while (page.data.nextCursor !== null) {
    page = await s.list(`?cursor=${page.data.nextCursor}&limit=2`);
    assert.ok(page.data.items.length <= 2);
    seen.push(...page.data.items);
  }
  assert.deepEqual(seen.map((item) => item.id).toSorted(), ids.toSorted(), "each file once");
  for (let n = 1; n < seen.length; n++) {
    const [newer, older] = [seen[n - 1], seen[n]];
    assert.ok(
      newer.expiresAt > older.expiresAt ||
        (newer.expiresAt === older.expiresAt && newer.id > older.id),
      "newest first",
    );
  }
  assert.equal((await s.list("?limit=51", 400)).error.code, "invalid_input");
  assert.equal((await s.list("?limit=0", 400)).error.code, "invalid_input");
  assert.equal((await s.list("?cursor=not-a-cursor", 400)).error.code, "invalid_cursor");

  // A continuation from another server is refused, not read against this one.
  const other = await s.x.server(s.account.id, { name: "Other" });
  const first = await s.list("?limit=1");
  const response = await s.x.raw(
    `/v1/servers/${other.id}/files/transfers?cursor=${first.data.nextCursor}`,
    { headers: { authorization: `Bearer ${await s.x.token()}` } },
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_cursor");
});

test("anyone with access to the server lists and downloads; nobody else can", async (t) => {
  const s = await setup(t);
  const sent = await s.send();
  assert.equal((await s.list("", 404, "user_bob")).error.code, "server_unavailable");
  assert.equal(
    (await s.download(sent.transfer.id, 404, "user_bob")).error.code,
    "server_unavailable",
  );

  await s.x.control("member", s.x.member(s.account.organizationId, "user_bob"));
  await s.x.call("user_alice", "PUT", `${s.root}/access/user_bob`);
  assert.equal((await s.list("", 200, "user_bob")).data.items.length, 1);
  assert.equal((await s.download(sent.transfer.id, 200, "user_bob")).data.fileName, "report.pdf");

  await s.x.call("user_alice", "DELETE", `${s.root}/access/user_bob`);
  assert.equal((await s.list("", 404, "user_bob")).error.code, "server_unavailable");
  assert.equal(
    (await s.download(sent.transfer.id, 404, "user_bob")).error.code,
    "server_unavailable",
  );

  // A transfer from another server is not found here, even with access to both.
  const other = await s.x.server(s.account.id, { name: "Other" });
  const response = await s.x.raw(
    `/v1/servers/${other.id}/files/transfers/${sent.transfer.id}/download`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${await s.x.token()}` },
    },
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "transfer_not_found");

  // The MCP connection is an agent credential, not a person's sign-in.
  const agent = await s.x.raw(`${s.root}/files/transfers`, {
    headers: { authorization: `Bearer ${await s.x.mcpToken(s.account.organizationId)}` },
  });
  assert.equal(agent.status, 401);
});

test("a person's download link is short-lived, names the file and leaves no receipt", async (t) => {
  const s = await setup(t);
  const sent = await s.send({ name: "Q3 report (final).pdf" });
  const { data } = await s.download(sent.transfer.id);
  const url = new URL(data.url);
  assert.equal(url.hostname, "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(
    url.pathname,
    `/talkto-test-transfers/r30/${s.server.id}/${sent.transfer.id}/payload`,
  );
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  assert.ok(url.searchParams.get("X-Amz-Signature"));
  assert.equal(
    url.searchParams.get("response-content-disposition"),
    "attachment;filename*=UTF-8''Q3%20report%20%28final%29.pdf",
  );
  assert.ok(!data.url.includes(" "), "no space for a query encoding to reinterpret");
  assert.ok(!data.url.includes("test-secret-key"), "the signing key never leaves the server");
  assert.equal(data.fileName, "Q3 report (final).pdf");
  const left = Date.parse(data.urlExpiresAt) - Date.now();
  assert.ok(left > 240_000 && left <= 300_000, `expires in five minutes, not ${left} ms`);

  // Receipts say which agents accepted the offer; a person's download is not one.
  const status = await s.call("read_transfer", { transferId: sent.transfer.id });
  assert.deepEqual(status.data.fetches, []);
  // Agents still get their hour-long, plain attachment link.
  const fetched = await s.call("fetch_transfer", {
    participantId: s.receiver,
    transferId: sent.transfer.id,
  });
  const agentUrl = new URL(fetched.data.url);
  assert.equal(agentUrl.searchParams.get("X-Amz-Expires"), "3600");
  assert.equal(agentUrl.searchParams.get("response-content-disposition"), "attachment");
});

test("a folder downloads as its packed archive", async (t) => {
  const s = await setup(t);
  const folder = await s.send({
    name: "site",
    kind: "folder",
    bytes: 32,
    fileCount: 2,
    manifestBytes: 12,
  });
  const { data } = await s.download(folder.transfer.id);
  assert.equal(data.fileName, "site.tar.gz");
  assert.equal(
    new URL(data.url).searchParams.get("response-content-disposition"),
    "attachment;filename*=UTF-8''site.tar.gz",
  );
  assert.ok(new URL(data.url).pathname.endsWith(`/${folder.transfer.id}/payload`));
  const packed = await s.send({
    name: "site.tgz",
    kind: "folder",
    bytes: 32,
    fileCount: 2,
    manifestBytes: 12,
  });
  assert.equal((await s.download(packed.transfer.id)).data.fileName, "site.tgz");
});

test("listing and downloading never use the message allowance", async (t) => {
  const s = await setup(t, { metering: true });
  const quota = async (action = "", data) => {
    const response = await s.x.control(`quota${action}?account=${s.account.id}`, data);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  await quota("/publish", {
    accountId: s.account.id,
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date(Date.now() + 3600000).toISOString(),
    allowance: 1000,
    overdraft: 0,
  });
  const report = () => s.x.control(`meter/report?server=${s.server.id}`);
  const sent = await s.send();
  await report();
  const before = await quota();
  assert.ok(before.used > 0, "sending is metered");
  for (let n = 0; n < 3; n++) {
    await s.list();
    await s.download(sent.transfer.id);
  }
  await report();
  const after = await quota();
  assert.equal(after.used, before.used);
  assert.equal(after.usageUpperBound, before.usageUpperBound);
});
