<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
- Engine, data, strategy, forecast and pattern rules live in src/lib/use/AGENTS.md; read it before changing anything under src/lib/use. Why: keeps root context small.
- Backend logic uses createServerFn; workers/cron use /api/public/* routes with DB-token auth. Why: forecasts must not depend on an open browser.
