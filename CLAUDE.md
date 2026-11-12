# CLAUDE.md – Idea Generator 2

Node 25 runs the TypeScript server directly; the frontend is vanilla ES modules. There is no build step. Port 8300, loopback only.

## Commands

- `npm start` – server on http://localhost:8300 (`PORT`, `HOST`, `DB_FILE` override)
- `npm test` – 76 tests (`node --test`), fake LLM, fake provider servers and fake CLIs, no network
- `npm run calibrate [-- --model provider:model]` – real judge against weak and strong reference ideas. It costs money. **Re-run it whenever the judge's prompt, schema or model changes.**

## Layout

- `server/providers.ts` – `provider:model` routing.
  - Ollama uses the native `/api/chat` with `think:false` and `format:schema`.
  - Anthropic uses the official SDK with `output_config.format`.
  - `agy:` and `claudecode:` are subscription CLIs run headless (`server/cli.ts`).
  - Everything else is OpenAI-compatible.
- `server/cli.ts` – one process per call for `agy -p` and `claude -p`, in an empty temp folder.
- `server/llm.ts` – every prompt, including the judge (`JUDGE_SYSTEM`). Each function takes `model`.
- `server/engine.ts` – every operation, the background judge queue (max 3) and the per-board event bus.
- `server/autopilot.ts` – the scheduler and the pure `rateCheck()`.
- `server/leads.ts` – the X and research scouts.
- `server/project.ts` – Claude Code folders.
- `server/vault.ts` – ideas as Obsidian notes (one `.md` per idea, a folder per board).
- `server/db.ts` – SQLite (`node:sqlite`), plus `report()` and `dashboard()` queries.
- `server/app.ts` – HTTP, SSE (`/api/boards/:id/events`) and Markdown exports.
- `public/js/score.js` and `public/js/evolve.js` – pure modules shared by the server, browser and tests. `evolve.js` also holds the repetition measures (`similarity`, `overused`), kinship and the breeding cut.
- `public/js/graph.js` – the canvas.
- `public/js/app.js` – the main app.
- `public/js/dashboard.js` and `public/js/report.js` – the trends and report views.

## Rules that matter

- **The medal comes from code, not the model:** a sum of three 1–5 scores, bronze from 9, silver from 11, gold from 13 (`score.js`). Left uncalibrated, an LLM jury gave 3/3 to the bare word "fire"; the calibration test keeps that from happening here.
- **Never put integer `minimum`/`maximum` in a JSON schema.** Anthropic rejects them. Put the range in the description and clamp in code.
- **Anthropic native: send no `temperature`.** API version 2026-10-21 rejects it. Use effort `low`. The SDK sends the key as a Bearer token.
- **OpenRouter: send `reasoning:{enabled:false}`** and retry without it on a 400 that mentions reasoning (some models insist on reasoning).
- **Groq (`json_validate_failed`):** reasoning models like GPT-OSS can spend the whole budget thinking and return empty JSON; retry once with 4× `max_tokens`, then fall back to JSON in the prompt.
- **X scout:** a lead is kept only if its URL is in the search engine's `url_citation` annotations. Never trust a URL the model wrote. Only OpenRouter (Grok) can search X.
- **Subscription CLIs (`agy:`, `claudecode:`):** no key, cost 0, at most two processes per CLI. The schema goes into the prompt and the JSON is pulled out of the text answer. `claude` gets the prompt on stdin and runs without `ANTHROPIC_API_KEY`, or it would bill the key instead of the subscription. `agy` gets it as an argument, or through `prompt.md` when it is over 20,000 characters or `agy` is a `.cmd` shim. `AGY_BIN` and `CLAUDE_BIN` override the lookup on PATH. The Test button runs `--version` and then one short call (90 s) to every model the roles use on that CLI (`probeModels`): a wrong model name otherwise only shows up as a silent autopilot backoff.
- **Generators are told what the jury said.** `expand` and `combine` receive the parents' scores and reasons, the board's jury guidance, the latest rejections and the board's overused words (`juryNotes` in `engine.ts`, `juryBrief` in `llm.ts`). One of an expansion's three ideas repairs its parent. Do not take this out: without it ten generations scored a flat 6/15.
- **A stuck board gets new material, then stops.** When 8 judged ideas in a row fail to beat the best (`stagnation` in `evolve.js`), the autopilot plants a fresh seed: an unused scout lead first (free, grounded), otherwise `llm.fresh` writes one from the best ideas, the summary's gaps and the jury's objections. The fresh seed is expanded before breeding resumes, or the breeding cut would bury it. After 2 fresh seeds that do not help (or 3 that only repeat the board), it idles with reason `exhausted` and the chip says so; a new best or a seed of the user's own restarts the count.
- **Repeats are dropped before they are judged:** same title, or word overlap of 0.5 and up (`DUPLICATE_AT`). Models paraphrase, so overlap only catches near-copies; `overused` and the jury's "similar ideas" handle the rest.
- **Weak ideas are hidden, never deleted.** "Hide weak" (`hiddenWeak` in `evolve.js`) takes ideas without a medal off the canvas, except seeds, unjudged ideas and the ancestors of anything that stays. They remain in the DB because `juryNotes` builds the generators' list of rejections from them.
- **The goal holds 4,000 characters.** At 600 a pasted brief was cut before its actual objective.
- **App settings live in the browser's localStorage.** The server holds them in memory, and the SSE `hello` tells the browser to push them again after a restart. Board configuration lives in the DB.
- **New boards start from `boardDefaults`** in the app settings (jury guidance, autopilot pace and limits), sent by the browser with `POST /api/boards`. "Use as default for new boards" in a board's settings fills it from that board and copies its model overrides to the app-wide models.
- **Dollar limits only see providers that report cost** (OpenRouter `usage.cost`, Anthropic via the price table). A limit of 0 means free models only.
- **Text goes into the DOM as text nodes, never `innerHTML`** (`dom.js`). Ideas are written by models and by visitors.
- **Vault notes only overwrite their own note:** a note is matched by `idea_id` in its properties; a hand-written note with the same name makes the idea's note `Name (2).md`.
- **Project folders never overwrite.** They are created with a non-recursive `mkdir`, and a taken name gets `-2`.

## Measured

- **Sonnet 5.5 judge** (2026-11-02):
  - weak ideas: mean 4.7, max 5
  - strong ideas: mean 9.8
  - run-to-run spread 0
  - about $0.003 per judgement
- **`ollama:qwen3:8b` as judge FAILS calibration:**
  - gave bronze to "Solpaneler på taken"
  - gave gold to 5 of 10 strong runs
  - spread 4 between runs
  - long reasons and Swedish errors

  Use local models to generate ideas, not to judge them.
- **X scout:** about 48 s and $0.04 per refresh; 5 of 6 leads were cited.
- **Before the jury feedback loop** (142 ideas on three boards, 2026-11-11): mean score flat at 6.0–6.75 over ten generations; a goal cut at 600 characters; 90 % of one board's ideas variations of one concept. Word overlap between an idea and its nearest earlier idea: median 0.26, so 0.5 is a near-copy.
- **Not yet measured:** `agy:` and `claudecode:` against the real CLIs (only fake binaries), and the judge after the `JUDGE_SYSTEM` change (similar ideas, two-sentence reason). Run `npm run calibrate -- --model claudecode:sonnet`.
- **Providers tested live:** OpenRouter, OpenAI and Ollama (generation and model listing). Not yet tested against the live services: Azure / Microsoft Foundry, MLX, LM Studio, and Anthropic direct (only against a fake server). GitHub Models was removed: GitHub retired it on 30 July 2026 (every endpoint now answers a bare `200 OK`). Use the Test button in Settings.
