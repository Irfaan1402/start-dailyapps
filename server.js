import express from "express";
import dotenv from "dotenv";

dotenv.config();

const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECT_KEY = "",
  STANDUP_LOOKBACK_DAYS = "",
  // Name of the future/backlog sprint holding tickets still to be estimated.
  JIRA_ESTIMATE_SPRINT = "À chiffrer",
  // Team-managed projects expose "Components" as a custom field rather than the
  // built-in `components` array, so the field id is configurable.
  JIRA_COMPONENT_FIELD = "customfield_10390",
  PORT = "3000",
} = process.env;

if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error(
    "Missing config. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in your .env file."
  );
  process.exit(1);
}

const authHeader =
  "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

const ISSUE_FIELDS = ["summary", "status", "assignee", "issuetype", "priority", "components", JIRA_COMPONENT_FIELD];

// Reads the component(s) of an issue, supporting both the built-in `components`
// array and a custom field (single option object or array of options).
const issueComponents = (issue) => {
  const builtin = (issue.fields.components ?? []).map((c) => c.name);
  const custom = issue.fields[JIRA_COMPONENT_FIELD];
  const customList = (Array.isArray(custom) ? custom : custom ? [custom] : [])
    .map((c) => c?.value ?? c?.name);
  return [...builtin, ...customList].filter(Boolean);
};

// How far back "completed since the last standup" reaches.
// On Mondays we look back across the weekend; otherwise one day.
const lookbackDays = () => {
  if (STANDUP_LOOKBACK_DAYS) return Number(STANDUP_LOOKBACK_DAYS);
  return new Date().getDay() === 1 ? 3 : 1;
};

const projectClause = JIRA_PROJECT_KEY ? `project = "${JIRA_PROJECT_KEY}" AND ` : "";

// The weekly meeting runs every Monday, so "this week" starts at the Monday of
// the current meeting cycle: this week's Monday in general, but the previous
// Monday when the board is opened on the meeting day itself (Monday), so the
// review still covers the full week just ended. Returns a "yyyy-MM-dd" string
// (00:00) usable directly in a JQL date clause.
const lastMeetingMonday = () => {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday, 1 = Monday, …
  const daysSinceMonday = (day + 6) % 7; // Mon→0, Tue→1, … Sun→6
  const offset = daysSinceMonday === 0 ? 7 : daysSinceMonday;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
  const pad = (n) => String(n).padStart(2, "0");
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
};

// Calls the current (non-deprecated) enhanced JQL search endpoint and
// follows nextPageToken until all matching issues are collected.
const searchIssues = async (jql) => {
  const collected = [];
  let nextPageToken;

  do {
    const body = { jql, fields: ISSUE_FIELDS, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const response = await fetch(`${JIRA_BASE_URL}/rest/api/3/search/jql`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Jira ${response.status}: ${detail}`);
    }

    const page = await response.json();
    collected.push(...(page.issues ?? []));
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);

  return collected;
};

const toCard = (issue) => ({
  key: issue.key,
  url: `${JIRA_BASE_URL}/browse/${issue.key}`,
  summary: issue.fields.summary,
  status: issue.fields.status?.name ?? "Unknown",
  category: issue.fields.status?.statusCategory?.key ?? "",
  type: issue.fields.issuetype?.name ?? "",
  priority: issue.fields.priority?.name ?? "",
  components: issueComponents(issue),
});

const assigneeName = (issue) =>
  issue.fields.assignee?.displayName ?? "Non assigné";

// Folds the two issue lists into one entry per person.
const groupByPerson = (todayIssues, doneIssues, estimateIssues) => {
  const people = new Map();
  const ensure = (name) => {
    if (!people.has(name)) people.set(name, { name, progress: [], todo: [], done: [], estimate: [] });
    return people.get(name);
  };

  for (const issue of todayIssues) {
    const card = toCard(issue);
    const bucket = card.category === "indeterminate" ? "progress" : "todo";
    ensure(assigneeName(issue))[bucket].push(card);
  }
  for (const issue of doneIssues) ensure(assigneeName(issue)).done.push(toCard(issue));
  for (const issue of estimateIssues) ensure(assigneeName(issue)).estimate.push(toCard(issue));

  return [...people.values()].sort((a, b) => {
    if (a.name === "Non assigné") return 1;
    if (b.name === "Non assigné") return -1;
    return a.name.localeCompare(b.name);
  });
};

// Folds the weekly issue lists into one entry per person.
const groupByPersonWeekly = (doneIssues, progressIssues) => {
  const people = new Map();
  const ensure = (name) => {
    if (!people.has(name)) people.set(name, { name, done: [], progress: [] });
    return people.get(name);
  };

  for (const issue of doneIssues) ensure(assigneeName(issue)).done.push(toCard(issue));
  for (const issue of progressIssues) ensure(assigneeName(issue)).progress.push(toCard(issue));

  return [...people.values()].sort((a, b) => {
    if (a.name === "Non assigné") return 1;
    if (b.name === "Non assigné") return -1;
    return a.name.localeCompare(b.name);
  });
};

const app = express();
app.use(express.static("public"));

app.get("/weekly", (_request, response) => {
  response.sendFile("weekly.html", { root: "public" });
});

app.get("/api/standup", async (_request, response) => {
  try {
    const days = lookbackDays();
    const todayJql = `${projectClause}sprint IN openSprints() AND statusCategory != Done ORDER BY assignee ASC, priority DESC`;
    const doneJql = `${projectClause}sprint IN openSprints() AND statusCategory = Done AND status CHANGED AFTER -${days}d ORDER BY assignee ASC`;
    const estimateJql = `${projectClause}sprint = "${JIRA_ESTIMATE_SPRINT}" ORDER BY assignee ASC, priority DESC`;

    const [todayIssues, doneIssues, estimateIssues] = await Promise.all([
      searchIssues(todayJql),
      searchIssues(doneJql),
      searchIssues(estimateJql),
    ]);

    response.json({
      generatedAt: new Date().toISOString(),
      lookbackDays: days,
      people: groupByPerson(todayIssues, doneIssues, estimateIssues),
    });
  } catch (error) {
    console.error(error);
    response.status(502).json({ error: String(error.message ?? error) });
  }
});

app.get("/api/weekly", async (_request, response) => {
  try {
    // Tickets moved to a Done status since the last Monday meeting, and tickets
    // that are currently in progress (entered "In Progress" and never left it).
    const since = lastMeetingMonday();
    const doneJql = `${projectClause}statusCategory = Done AND status CHANGED TO Done AFTER "${since}" ORDER BY assignee ASC, priority DESC`;
    const progressJql = `${projectClause}statusCategory = "In Progress" AND created < startOfDay() ORDER BY assignee ASC, priority DESC`;

    const [doneIssues, progressIssues] = await Promise.all([
      searchIssues(doneJql),
      searchIssues(progressJql),
    ]);

    response.json({
      generatedAt: new Date().toISOString(),
      people: groupByPersonWeekly(doneIssues, progressIssues),
    });
  } catch (error) {
    console.error(error);
    response.status(502).json({ error: String(error.message ?? error) });
  }
});

app.listen(Number(PORT), () => {
  console.log(`Standup board running at http://localhost:${PORT}`);
});
