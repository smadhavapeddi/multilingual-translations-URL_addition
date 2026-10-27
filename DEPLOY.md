# Deploying to App Platform

This folder (`multilingual-translation-demo/`) is a complete, self-contained
Node.js web app — `server.js` + `package.json` — ready to deploy as-is.

## 1. Push this code to GitHub (or GitLab)

App Platform deploys from a git repo, not a local folder.

```bash
cd multilingual-translation-demo
git init
git add .
git commit -m "Multilingual translation demo"
git branch -M main
git remote add origin https://github.com/<your-username>/multilingual-translation-demo.git
git push -u origin main
```

With this layout — this folder *is* the repo root — `app.yaml`'s
`source_dir` line should stay commented out/deleted, which it already is.

If you'd rather push this as a subfolder of a bigger repo, uncomment
`source_dir: /multilingual-translation-demo` (or whatever path you used) in
`app.yaml`.

## 2. Fill in `app.yaml`

Edit `app.yaml` in this folder:

- `github.repo`: set to `<your-username>/multilingual-translation-demo`
- `github.branch`: usually `main`
- `MODEL_ACCESS_KEY` value: leave the placeholder for your first deploy —
  `DRY_RUN=true` means it isn't needed yet. Set the real value later via the
  Control Panel or `doctl`, not by committing it to git.
- `MODEL_ID`: defaults to `openai-gpt-oss-120b`; change it if you want a
  different translation model from the start.

## 3. Deploy

**Using `doctl`:**

```bash
doctl apps create --spec app.yaml
```

This comes up with `DRY_RUN=true` — safe, no key needed, no spend — so you
can confirm the deploy works before adding real credentials.

**Using the Control Panel:**

Apps → Create App → GitHub → pick the repo/branch → App Platform
auto-detects Node.js from `package.json` → on the review screen, paste in
`app.yaml`'s contents (Edit Your App Spec) or set `http_port: 8080` and the
three env vars manually → Create Resources.

## 4. Verify the dry-run deploy

Open `https://<your-app>.ondigitalocean.app/`:

- The page should show a "dry run" badge and the mock-mode note.
- Load one of the example presets (support email or product description),
  leave Spanish + Japanese checked, click **Translate** — you should see two
  result cards appear within a second, each clearly labeled as a mock
  translation.
- `/healthz` should return `ok`.

## 5. Go live

1. Get a real model access key: Control Panel → **Inference** →
   **Model Access Keys** → Create Model Access Key.
2. Confirm the team's Inference & Agents balance is positive (Serverless
   Inference is prepaid).
3. In the app's Settings → `web` component → Environment Variables:
   - Set `MODEL_ACCESS_KEY` to the real key (mark it **Encrypted**).
   - Set `DRY_RUN` to `false`.
   - Optionally bump `MODEL_ID` to a stronger model for better quality.
4. Save — App Platform redeploys automatically.
5. Reload the app and click **Translate** again. This now sends one real
   request per selected language to
   `https://inference.do-ai.run/v1/chat/completions` and shows real
   translations, token counts, and latency.

## Notes

- `instance_size_slug: apps-s-1vcpu-1gb` is the smallest paid tier — plenty
  for this app.
- `deploy_on_push: true` means every push to `branch` auto-redeploys; turn
  it off in `app.yaml` for manual control.
- As shipped, `/api/translate` has no auth and no rate limiting beyond input
  size caps — fine for a guided demo, but add basic auth or an allowlist
  before leaving it publicly reachable with a live key for an extended
  period.
