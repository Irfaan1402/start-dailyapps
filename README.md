# Standup Board

A live daily-standup board for a developer team, built from your **current open Jira sprint**. It groups every sprint issue by assignee into two columns — *completed since the last standup* and *in progress / planned today* — and refreshes itself every minute, so it always reflects Jira. Open it on the shared screen and run the standup off it.

Because the board queries Jira on every refresh, there's no document to regenerate: when someone moves a ticket to Done in Jira, it moves to the "completed" column on the next refresh.

## Why there's a tiny server

The Jira API token must never live in a browser tab (anyone viewing the page could read it, and Jira blocks browser-origin calls anyway). So `server.js` holds the token, talks to Jira, and serves the dashboard. The browser only ever talks to your own server.

## 1. Create a Jira API token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. **Create API token**, give it a name like `standup-board`, pick an expiry (Atlassian allows 1–365 days).
3. Copy the token — you won't see it again.

For a team tool, the cleaner option is a dedicated **service account** with a scoped token (`read:jira-work`) created under Atlassian Administration → Directory → Service accounts, so the board isn't tied to one person's login. A personal token works fine to start.

## 2. Configure

```bash
cp .env.example .env
```

Fill in `.env`: your site URL (`https://your-team.atlassian.net`), the token owner's email, and the token. Optionally set `JIRA_PROJECT_KEY` to scope the board to one project.

## 3. Run

```bash
npm install
npm start
```

Open http://localhost:3000.

## How the data is selected

Two JQL queries, both scoped to `sprint IN openSprints()`:

- **Planned today:** `statusCategory != Done` — everything still open in the sprint.
- **Completed:** `statusCategory = Done AND status CHANGED AFTER -Nd` — N is 1 day normally, 3 on Mondays (to catch the weekend). Override with `STANDUP_LOOKBACK_DAYS`.

Tune these in `server.js` (the `todayJql` / `doneJql` strings) if your workflow uses custom statuses.

## Where to take it next with Claude Code

From this repo, point Claude Code at concrete extensions, for example:

- "Add a per-person view at `/me` that reads the logged-in user from a query param."
- "Also write a Markdown snapshot to `history/YYYY-MM-DD.md` each morning as a permanent record."
- "Add a refresh that's triggered by a Jira webhook instead of polling every 60s."
- "Deploy this to our internal host / a container."

If you later want a scheduled job (e.g. a morning snapshot) run by Claude Code in `claude -p` headless mode, drive Jira through this direct-API code rather than a remote MCP connection — remote MCP tools are currently unreliable in headless mode, whereas a plain token + REST call always works unattended.
