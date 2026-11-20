# Agent icons

Downloaded on 9 September 2026 from the agent section of Cloudflare's [Wrangler authorization page](https://welcome.developers.workers.dev/wrangler-oauth-consent-granted):

- [Claude](https://welcome.developers.workers.dev/icons/agents/claude/light.svg)
- [Codex](https://welcome.developers.workers.dev/icons/agents/codex/light.svg)
- [Cursor](https://welcome.developers.workers.dev/icons/agents/cursor/light.svg)

These files preserve the downloaded SVGs. The self-contained design artifact embeds their paths as SVG symbols. Fills inherit `currentColor`; source styles and unused metadata are excluded. No runtime asset request is required.

## pi.dev

`pi.svg` preserves the SVG supplied on 9 September 2026, replacing Copilot. Its original white fills and 800×800 viewBox are retained. The embedded symbol inherits the foreground color and fits the artwork bounds so its visible size matches the other agent marks. No path geometry is changed.

## Active colors

The messaging animation adds color to the active sender and receiver. The downloaded source SVGs remain unchanged.

- Claude: `#D97757`, from the supplied icon; a lighter orange is used on dark surfaces.
- Codex: blue, a design choice. `#2874DB` and the lighter dark-surface `#66AAFF` are illustration choices, not asserted official brand hex values.
- Cursor: its supplied `#26251E` monochrome mark and a light neutral counterpart. [Cursor's brand page](https://cursor.com/en-US/brand) provides light and dark assets; no chromatic accent was established from it.
- pi.dev: neutral charcoal on light surfaces and a light neutral on dark surfaces, following the supplied monochrome mark.

## Droid

Droid comes from the TalkTo brand kit (kept outside this repository with its own source notes), added on 11 November 2026.

- `droid.png` is derived from the kit's `droid.png` app icon (826×826, white mark on a dark rounded square). The mark's brightness became a white alpha mask, cropped to the mark's bounds and scaled to 128×128. The shape is not redrawn. The symbol fills `currentColor` through this mask, so Droid follows the light and dark foreground like the other marks.
- In the messaging animation Droid and Grok use the neutral Cursor and pi.dev colors, because both marks are monochrome.

## Grok, OpenClaw and Hermes Agent

Replaced on 14 November 2026 with the marks the Plannotator Inbox uses (the earlier marks were
wrong). The geometry is unchanged.

- Grok: the Grok Bot mark, from the x.ai/bot hero mark, viewBox `16 16 60 60`. Every Grok tool
  (Grok Build, Grok on grok.com and Grok Bot) shows it. The Setup page draws a `#0b0b0c` circle
  with white eyes and swaps the two colours in the dark theme, as the Inbox does. The dashboard
  symbol is the circle in the text colour with the eyes cut out (even-odd fill). It replaces the
  brand kit's `grok-light.svg` (LobeHub icon set); `grok.svg` is removed.
- OpenClaw: the outline lobster, from openclaw/openclaw `ui/src/components/icon-data-tools.ts`
  (MIT, Copyright (c) 2026 OpenClaw Foundation). It is a 24×24 outline stroked in the text colour,
  1.6 wide with round caps and joins. It replaces the red gradient lobster from
  `ui/public/favicon.svg`.
- Hermes Agent: the Nous girl, `hermes-light.png` and `hermes-dark.png`, two PNG alpha masks made
  from NousResearch/hermes-agent at commit 94e0389cf48b3f7c95b2a9e376ab945af74e03fa,
  `assets/nous-girl-black.svg` and `assets/nous-girl-white.svg` (MIT, Copyright (c) 2025 Nous
  Research). Each is filled with the text colour: the light mask in the light theme, the dark mask
  in the dark theme. They replace the 116 KB `hermes.svg` portrait from `assets/icon-master.svg`,
  which is removed.

## Setup page colour marks

`src/agent-brand-marks.tsx` draws the Setup page's colour marks inline, in the style of the
Plannotator Inbox's large marks (a square tile per mark). They follow the Inbox's choices, ported
on 11 November 2026:

- Claude: the Inbox's 32-unit Claude path in `#D97757`, on both themes.
- Codex: the Inbox shows the Codex app icon as a 128-pixel PNG (a lavender-to-blue cloud with a
  white prompt). The Setup page redraws it as a vector: the cloud and prompt paths of the Codex
  symbol above, split into a gradient cloud (`#B9ABF3` → `#6A8AF2` → `#3127F0`, sampled from the
  PNG) and a white prompt.
- pi: the Inbox's pi.dev logo in its own three colours (`#F09082`, `#4D9ABF`, `#F1BE58`).
- opencode: the Inbox's two-tone mark in the text colour; opencode's mark is monochrome.
- Cursor: the white cube facet of the Inbox's Cursor app icon; the black tile is the icon's square.
- Grok: the Inbox's Grok Bot mark (above) on a soft tile, near-black with white eyes, swapped in
  the dark theme.
- Droid: the bundled `droid.png` alpha mask, white on a black app tile, matching the kit's app icon.
- Amp (added 12 November 2026): the dashboard's existing `agent-amp` wordmark path
  (`additional-agent-symbols.tsx`), unchanged, white on a black app tile like Cursor, Grok and Droid.
- Any MCP tool: a plug drawn for the page, in the muted text colour on a dashed tile.

## Official marks for the MCP tools

Added on 12 November 2026, replacing the neutral generic mark. Each comes from the maker's own
site, brand kit or official repository; geometry is unchanged. The raw downloads and their URLs are
kept outside the repository with the other icon sources.

- Antigravity: `antigravity-icon__full-color.svg` from Google's Antigravity press kit
  (https://antigravity.google/press). Mask and blur filters kept; IDs made unique per render; the
  viewBox is tightened to the mark.
- Devin: `symbol-light.svg` from Cognition's brand kit (https://devin.ai/brand). The white
  background is dropped and the black fill follows the text colour.
- OpenClaw and Hermes Agent: the Plannotator Inbox's marks (see "Grok, OpenClaw and Hermes
  Agent" above), in the text colour on a soft tile. Hermes is a CSS mask that changes with the
  theme.
- ChatGPT (mark id `chatgpt`): OpenAI's Blossom from https://openai.com/brand, the dashboard's `agent-openai`
  symbol, in the text colour.
- Poke: the palm mark from poke.com's site header (an inline SVG already in the text colour).
- Town: the mark from town.com's site header (an inline SVG in the text colour; the same mark as
  its favicon).
- Muse and Muse Code (mark id `muse`): Meta's Muse squiggle, `images/favicon/app-squiggle.svg` from
  https://muse.ai, Muse's site. Muse Code's own pages (dev.meta.ai) show only the Meta logo, so both
  share Muse's mark. The display-p3 colour overrides are dropped; the sRGB stops stay.

## Dashboard symbols for the same tools

Added on 12 November 2026 so a registered agent of each kind shows its own mark in the dashboard
(`additional-agent-symbols.tsx`), not the generic one. Each is the Setup page mark above in the
dashboard's one colour (`currentColor`); geometry is unchanged.

- Antigravity: the press-kit icon's outline path alone, without its colour fields and blurs.
- Devin, Poke, Town and Muse: the same paths; Muse's gradient becomes the text colour.
- OpenClaw: the outline lobster, stroked in the text colour.
- Hermes Agent: `hermes-light.png` or `hermes-dark.png`, following the theme, as an alpha mask
  over the text colour, as Droid's mark is drawn.
- ChatGPT keeps the existing `agent-openai` symbol.

## Gemini CLI

`gemini-cli.png` is Gemini CLI's app icon from its official site, https://geminicli.com/icon.png (1645×1645 PNG). Google publishes it only as a picture. It was scaled to 160×160 with its transparency kept; nothing was redrawn. It replaces the Gemini spark on the Setup page, the Connect agents dialog and the docs, on 12 November 2026.
