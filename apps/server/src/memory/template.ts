/**
 * The first commit of a new swarm memory (docs/swarm-server-spec.md, 14.3): one root `AGENTS.md`
 * of high-level norms and a map to deeper files. The folders it names stay empty until used.
 */
export const message = "Start swarm memory from TalkTo's template";

export const files: ReadonlyArray<{ readonly path: string; readonly text: string }> = [
  {
    path: "AGENTS.md",
    text: `# Swarm memory

What this swarm knows that the code cannot tell you. The code is the authority: when memory and
the code disagree, trust the code and correct memory in the same task.

## Norms
- This file is norms and a map, read at the start of every task. Keep it short; put detail in
  deeper files and point to them here.
- Record what the code cannot say: traps, environment quirks, decisions and their reasons,
  research with its sources, and things outside the repository.
- Never record what you changed or fixed: the code and Git history say that, and every worker
  starts from its own copy of the code.
- Before you add a line, read the file it belongs in and edit the line already there.
- A wrong line here misleads every worker after you. Fix it, and say why in the commit message.
- When you add a deeper file, add its line to the map below in the same commit.

## Map
- \`decisions/\`: one file per key decision and its reasons. Open before you change that area.
  (Empty so far.)
- \`research/\`: studies and findings that settle a question, with their sources. (Empty so far.)
- \`traps/\`: one file per area that has bitten someone, named like a task label, such as
  \`traps/payments.md\`. (Empty so far.) An example of a good trap line:
  "The payments API returns integer cents, and reports errors with HTTP 200 and an \`error\`
  field: check the body, not the status."
- \`outside.md\`: what lives outside the repository: dashboards, sandboxes, accounts, owners.
  (Not written yet.)

A file named like a task's label, listing it in its front matter (\`labels: [payments]\`), or
whose map line names the label comes with that task's claim. Every other file is one read_memory
away.
`,
  },
];
