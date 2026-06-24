import express from "express";
import dotenv from "dotenv";

dotenv.config();

const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECT_KEY = "",
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

const ISSUE_FIELDS = ["summary", "status", "assignee", "issuetype", "priority", "components", "issuelinks", "resolutiondate", "statuscategorychangedate", JIRA_COMPONENT_FIELD];

// Reads the component(s) of an issue, supporting both the built-in `components`
// array and a custom field (single option object or array of options).
const issueComponents = (issue) => {
  const builtin = (issue.fields.components ?? []).map((c) => c.name);
  const custom = issue.fields[JIRA_COMPONENT_FIELD];
  const customList = (Array.isArray(custom) ? custom : custom ? [custom] : [])
    .map((c) => c?.value ?? c?.name);
  return [...builtin, ...customList].filter(Boolean);
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

const storyRef = (key, summary) => ({
  key,
  url: `${JIRA_BASE_URL}/browse/${key}`,
  summary: summary ?? key,
});

// The Story a card should be grouped under. The team does not use Jira's
// parent/child hierarchy for this (the real parent is the Epic); instead delivery
// tasks are tied to their umbrella Story with a "Relates" issue link. So:
//   - a Story is its own group header;
//   - any other ticket joins the Story it "relates to".
// The linked Story's summary is returned inline by Jira, so the grouping works
// even when that Story is assigned to someone else (or not in the result set).
const groupStory = (issue) => {
  if (issue.fields.issuetype?.name === "Story") {
    return storyRef(issue.key, issue.fields.summary);
  }
  for (const link of issue.fields.issuelinks ?? []) {
    if (link.type?.name !== "Relates") continue;
    const linked = link.inwardIssue ?? link.outwardIssue;
    if (linked?.fields?.issuetype?.name === "Story") {
      return storyRef(linked.key, linked.fields.summary);
    }
  }
  return null;
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
  parent: groupStory(issue),
  // When the ticket was completed, used to order the finished column. Falls back
  // to the status-category change date when no resolution date is set.
  finishedAt: issue.fields.resolutiondate ?? issue.fields.statuscategorychangedate ?? null,
});

const assigneeName = (issue) =>
  issue.fields.assignee?.displayName ?? "Non assigné";

// The status category a Story-group lands in is decided from its members:
//  - done     : every ticket in the group is finished;
//  - progress : at least one ticket is finished or in progress (but not all done);
//  - todo     : no ticket is finished or in progress.
const groupColumn = (cards) => {
  if (cards.every((c) => c.category === "done")) return "done";
  const active = cards.some((c) => c.category === "done" || c.category === "indeterminate");
  return active ? "progress" : "todo";
};

// The key a card is grouped under: its Story when one is linked, otherwise the
// card stands on its own.
const groupKey = (card) => (card.parent ? card.parent.key : `solo:${card.key}`);

// Folds every assigned sprint issue into one entry per person. Issues are grouped
// by their Story and the whole group is placed in a single column based on the
// aggregate status of its members, so a Story shows up once — not split across
// columns. The "À chiffrer" list keeps its flat, component-only display, so its
// cards carry no Story grouping.
const groupByPerson = (dailyIssues, estimateIssues) => {
  const people = new Map();
  const ensure = (name) => {
    if (!people.has(name)) people.set(name, { name, progress: [], todo: [], done: [], estimate: [] });
    return people.get(name);
  };

  // name -> (groupKey -> cards[])
  const byPerson = new Map();
  for (const issue of dailyIssues) {
    const name = assigneeName(issue);
    const card = toCard(issue);
    if (!byPerson.has(name)) byPerson.set(name, new Map());
    const groups = byPerson.get(name);
    const key = groupKey(card);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }

  for (const [name, groups] of byPerson) {
    const person = ensure(name);
    for (const cards of groups.values()) {
      // Tickets in a group normally share one composant; a member with none of
      // its own inherits the group's so the whole group stays under one heading
      // instead of splitting a stray ticket into "Sans composant".
      const groupComponents = [...new Set(cards.flatMap((c) => c.components))];
      if (groupComponents.length) {
        for (const c of cards) if (!c.components.length) c.components = groupComponents;
      }
      const column = groupColumn(cards);
      person[column].push(...cards);
    }
  }

  for (const issue of estimateIssues) {
    ensure(assigneeName(issue)).estimate.push({ ...toCard(issue), parent: null });
  }

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

// Translates English text to French via Google's public translate endpoint.
const translateToFrench = async (text) => {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fr&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Translate ${response.status}`);
  const data = await response.json();
  return data[0].map((segment) => segment[0]).join("");
};

// A random technology quote, translated to French, used as the page header.
// The original api.quotable.io currently serves an expired TLS certificate, so we
// use the maintained Kurokeita mirror of the same quotable dataset.
app.get("/api/quote", async (_request, response) => {
  try {
    const quoteResponse = await fetch(
      "https://api.quotable.kurokeita.dev/api/quotes/random?tags=Technology"
    );
    if (!quoteResponse.ok) throw new Error(`Quote ${quoteResponse.status}`);
    const { quote } = await quoteResponse.json();
    response.json({
      text: await translateToFrench(quote.content),
      author: quote.author?.name ?? "",
    });
  } catch (error) {
    console.error(error);
    response.status(502).json({ error: String(error.message ?? error) });
  }
});

app.get("/api/standup", async (_request, response) => {
  try {
    // All current-sprint work, so a Story's full set of tickets is available to
    // decide which column the group belongs in regardless of individual statuses.
    const dailyJql = `${projectClause}sprint IN openSprints() ORDER BY assignee ASC, priority DESC`;
    const estimateJql = `${projectClause}sprint = "${JIRA_ESTIMATE_SPRINT}" ORDER BY assignee ASC, priority DESC`;

    const [dailyIssues, estimateIssues] = await Promise.all([
      searchIssues(dailyJql),
      searchIssues(estimateJql),
    ]);

    response.json({
      generatedAt: new Date().toISOString(),
      people: groupByPerson(dailyIssues, estimateIssues),
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
