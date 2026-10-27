# Multilingual Support / Content Translation Demo

A live, self-serve demo of DigitalOcean **Serverless Inference** translating
support emails and product copy in real time. Type or paste text in English
(or any language), pick target languages, click Translate, and see
side-by-side results appear in a couple of seconds — no page reload.

Pitch: "Your inbound support queue and your product descriptions probably
already need to go out in Spanish, Japanese, and a dozen other languages.
Here's that, live, with one API call per language."

Zero external dependencies — Node.js 18+ standard library (`http`, built-in
`fetch`) only, vanilla JS/CSS on the front end. One file, `server.js`, is the
whole app.

## What it does

- A textarea for free-form text, plus two one-click example loaders: an
  **inbound support email** (angry customer, locked out of their account)
  and a **product description** (a SaaS backup tool's marketing blurb).
- Checkboxes for 10 target languages (Spanish and Japanese checked by
  default, per the classic pitch — add French, German, Portuguese, Chinese,
  Korean, Arabic, Hindi, Italian as needed, up to 6 at a time).
- Click **Translate** → the browser calls `POST /api/translate`, which fires
  one DigitalOcean Inference request per selected language *in parallel* and
  renders each translation in its own card with token counts and latency, as
  soon as it comes back.
- A `DRY_RUN` mode that returns clearly-labeled mock translations with a
  small artificial delay, so you can rehearse the demo flow with no API key
  and no cost.

## Run it locally

```bash
cd multilingual-translation-demo
DRY_RUN=true PORT=8080 node server.js
# open http://localhost:8080
```

To hit the real API locally instead:

```bash
export MODEL_ACCESS_KEY=sk-...
PORT=8080 node server.js
```

### Env vars

| Var                | Default                | Notes                                                                 |
|---------------------|------------------------|------------------------------------------------------------------------|
| `MODEL_ACCESS_KEY`  | *(none)*               | Required unless `DRY_RUN=true`. Control Panel → Inference → Model Access Keys. |
| `MODEL_ID`          | `openai-gpt-oss-120b`  | Fast and cheap. Swap in `anthropic-claude-5-sonnet` or similar for noticeably better translation quality, at higher per-token cost. |
| `DRY_RUN`           | `false`                | `true` = mock translations, no network calls, no cost.                |
| `PORT`              | `8080`                 | App Platform sets this automatically.                                 |

## Deploying to App Platform

This folder is ready to deploy as-is. See **`DEPLOY.md`** for the full
step-by-step (push to GitHub, fill in `app.yaml`, deploy with `doctl` or the
Control Panel, verify dry-run, then go live with a real key).

Quick version:

```bash
git init && git add . && git commit -m "Multilingual translation demo"
git remote add origin https://github.com/<you>/multilingual-translation-demo.git
git push -u origin main
# fill in github.repo in app.yaml, then:
doctl apps create --spec app.yaml
```

## Customizing for a specific prospect

- Edit `PRESET_EXAMPLES` near the top of `server.js` to swap in the
  prospect's own support ticket text or product copy.
- Edit `LANGUAGES` to match the markets they're actually expanding into.
- Bump `MODEL_ID` to a stronger model before a customer-facing demo if
  translation nuance matters more than cost.

## Notes

- Each selected language is a separate, independent Inference API call, run
  in parallel — one slow or failing language doesn't block the others from
  rendering.
- Translations are not reviewed or post-edited; call this out live as "AI
  draft translation, human review recommended before sending to real
  customers," especially for support-sensitive content.
- Text is capped at 3,000 characters and 6 target languages per request to
  keep the demo fast and cheap; raise `MAX_TEXT_LEN` / `MAX_TARGET_LANGS` in
  `server.js` if you need more.
