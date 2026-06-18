import { base64ToBytesSafe } from "./encoding";
import { decodeURIComponentSafe } from "./github-path";
import { isRecord } from "./object";

type RunState = {
  status: string;
  conclusion: string | null;
};

export type ActionsJobSummary = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  href: string;
};

export function parseActionsRunListHTML(
  html: string,
  owner: string,
  repo: string,
): { total_count: number; workflow_runs: Record<string, unknown>[] } | undefined {
  const totalMatch = /<strong>([0-9,]+) workflow runs?(?: results?)?<\/strong>/.exec(html);
  const total = totalMatch === null ? undefined : Number(totalMatch[1]!.replaceAll(",", ""));
  const cards = actionsRunCards(html);
  const runs: Record<string, unknown>[] = [];
  const runPath = `/${escapeRegex(owner)}/${escapeRegex(repo)}/actions/runs/`;

  for (const card of cards) {
    const anchor = new RegExp(`href="${runPath}([0-9]+)"[^>]*aria-label="([^"]+)"`).exec(card);
    if (anchor === null) {
      continue;
    }
    const state = runState(decodeHTML(anchor[2]!));
    if (state === undefined) {
      continue;
    }
    const title = textMatch(card, /class="[^"]*markdown-title[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const workflow = textMatch(
      card,
      /<span class="text-bold"[^>]*>([\s\S]*?)<\/span>\s*#([0-9]+):/,
    );
    const runNumber = /<span class="text-bold"[^>]*>[\s\S]*?<\/span>\s*#([0-9]+):/.exec(card)?.[1];
    const createdAt = /<relative-time[\s\S]*?datetime="([^"]+)"/.exec(card)?.[1];
    if (
      title === undefined ||
      workflow === undefined ||
      runNumber === undefined ||
      createdAt === undefined
    ) {
      continue;
    }
    const id = Number(anchor[1]);
    const sha = new RegExp(
      `href="/${escapeRegex(owner)}/${escapeRegex(repo)}/commit/([0-9A-Fa-f]{7,64})"`,
    ).exec(card)?.[1];
    const branch = new RegExp(
      `href="/${escapeRegex(owner)}/${escapeRegex(repo)}/tree/refs/heads/([^"]+)"`,
    ).exec(card)?.[1];
    const duration = /aria-label="Run duration"[\s\S]*?<\/svg>\s*<span>\s*([^<]+)</.exec(card)?.[1];
    runs.push({
      id,
      name: workflow,
      display_title: title,
      run_number: Number(runNumber),
      status: state.status,
      conclusion: state.conclusion,
      html_url: `https://github.com/${owner}/${repo}/actions/runs/${id}`,
      head_branch: branch === undefined ? null : decodeURIComponentSafe(branch),
      head_sha: sha ?? null,
      event: runEvent(card),
      created_at: createdAt,
      updated_at: addDuration(createdAt, duration) ?? createdAt,
    });
  }

  if (runs.length === 0 && total !== 0) {
    return undefined;
  }
  return { total_count: total ?? runs.length, workflow_runs: runs };
}

function actionsRunCards(html: string): string[] {
  const starts: number[] = [];
  for (const match of html.matchAll(/<div\b[^>]*class="([^"]*)"[^>]*>/g)) {
    if (match.index === undefined) {
      continue;
    }
    const classes = new Set(match[1]!.split(/\s+/));
    if (
      classes.has("Box-row") &&
      classes.has("js-socket-channel") &&
      classes.has("js-updatable-content")
    ) {
      starts.push(match.index);
    }
  }
  return starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.length));
}

export function parseActionsRunHTML(
  html: string,
  owner: string,
  repo: string,
  id: number,
): Record<string, unknown> | undefined {
  const title = textMatch(
    html,
    /<h1[^>]*class="[^"]*PageHeader-title[^"]*"[\s\S]*?<span class="markdown-title"[^>]*>([\s\S]*?)<\/span>/,
  );
  const workflow = textMatch(html, /class="PageHeader-parentLink-label"[^>]*>([\s\S]*?)<\/span>/);
  const stateLabel =
    /class="[^"]*actions-workflow-runs-status[^"]*"[\s\S]*?aria-label="([^"]+)"/.exec(html)?.[1];
  const state = stateLabel === undefined ? undefined : runState(decodeHTML(stateLabel));
  const runNumber = new RegExp(
    `<span class="markdown-title"[\\s\\S]*?</span>\\s*<span[^>]*>\\s*#([0-9]+)`,
  ).exec(html)?.[1];
  const trigger = /Triggered via\s+([^<]+?)\s*<relative-time[^>]*datetime="([^"]+)"/.exec(html);
  const sha =
    new RegExp(
      `href="/${escapeRegex(owner)}/${escapeRegex(repo)}/commit/([0-9A-Fa-f]{7,64})"`,
    ).exec(html)?.[1] ??
    new RegExp(
      `(?:\\u00b7|&#183;)\\s*${escapeRegex(owner)}/${escapeRegex(repo)}@([0-9A-Fa-f]{7,64})`,
    ).exec(html)?.[1];
  const branch = actionsRunBranch(html, owner, repo);
  if (
    title === undefined ||
    workflow === undefined ||
    state === undefined ||
    runNumber === undefined ||
    trigger === null ||
    sha === undefined
  ) {
    return undefined;
  }
  const duration = /Total duration[\s\S]*?class="[^"]*color-fg-default[^"]*"[^>]*>\s*([^<]+)</.exec(
    html,
  )?.[1];
  const createdAt = trigger[2]!;
  return {
    id,
    name: workflow,
    display_title: title,
    run_number: Number(runNumber),
    status: state.status,
    conclusion: state.conclusion,
    html_url: `https://github.com/${owner}/${repo}/actions/runs/${id}`,
    head_branch: branch ?? null,
    head_sha: sha,
    event: trigger[1]!
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
    created_at: createdAt,
    updated_at: addDuration(createdAt, duration) ?? createdAt,
  };
}

export function parseCommitPatchSHA(patch: string): string | undefined {
  return /^From ([0-9A-Fa-f]{40,64})\s/m.exec(patch)?.[1];
}

export function parseActionsJobGroupsJSON(
  value: unknown,
  owner: string,
  repo: string,
  runID: number,
): ActionsJobSummary[] | undefined {
  if (!isRecord(value) || value.hasMore !== false || !Number.isInteger(value.totalCount)) {
    return undefined;
  }
  const expectedPath = `/${owner}/${repo}/actions/runs/${runID}/job/`;
  const jobs = new Map<number, ActionsJobSummary>();
  collectJobSummaries(value.jobGroups, expectedPath, jobs);
  if (jobs.size !== value.totalCount || jobs.size === 0) {
    return undefined;
  }
  return [...jobs.values()];
}

export function parseActionsJobHTML(
  html: string,
  summary: ActionsJobSummary,
  owner: string,
  repo: string,
): Record<string, unknown> | undefined {
  const steps: Record<string, unknown>[] = [];
  for (const match of html.matchAll(/<check-step\b([\s\S]*?)>/g)) {
    const attributes = match[1]!;
    const name = htmlAttribute(attributes, "data-name");
    const number = Number(htmlAttribute(attributes, "data-number"));
    const startedAt = htmlAttribute(attributes, "data-started-at");
    const completedAt = htmlAttribute(attributes, "data-completed-at");
    const conclusion = htmlAttribute(attributes, "data-conclusion");
    if (name === undefined || !Number.isInteger(number)) {
      return undefined;
    }
    steps.push({
      name,
      number,
      status:
        completedAt !== undefined
          ? "completed"
          : startedAt !== undefined
            ? "in_progress"
            : "queued",
      conclusion: conclusion ?? null,
      started_at: startedAt ?? null,
      completed_at: completedAt ?? null,
    });
  }
  const startedAt = firstTimestamp(steps, "started_at");
  const completedAt = new RegExp(
    `data-url="/${escapeRegex(owner)}/${escapeRegex(repo)}/runs/${summary.id}/header"[\\s\\S]{0,1000}?<relative-time[^>]*datetime="([^"]+)"`,
  ).exec(html)?.[1];
  if (
    (summary.status === "completed" && completedAt === undefined) ||
    (summary.status !== "queued" && steps.length === 0)
  ) {
    return undefined;
  }
  return {
    id: summary.id,
    name: summary.name,
    status: summary.status,
    conclusion: summary.conclusion,
    started_at: startedAt,
    completed_at: completedAt ?? null,
    html_url: `https://github.com${summary.href}`,
    steps,
  };
}

export function parseReleaseHTML(
  html: string,
  owner: string,
  repo: string,
  responseURL: string,
): Record<string, unknown> | undefined {
  const tag = releaseTag(responseURL);
  const name = textMatch(
    html,
    /breadcrumb-item-selected[\s\S]*?<\/nav>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/,
  );
  const publishedAt = /released this[\s\S]{0,800}?<relative-time[^>]*datetime="([^"]+)"/.exec(
    html,
  )?.[1];
  if (tag === undefined || name === undefined || publishedAt === undefined) {
    return undefined;
  }
  const bodyHTML =
    /data-test-selector="body-content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div[^>]*class="Box-footer"/.exec(
      html,
    )?.[1] ?? "";
  return {
    tag_name: tag,
    name,
    html_url: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    draft: false,
    prerelease: />\s*Pre-release\s*</i.test(html),
    created_at: publishedAt,
    published_at: publishedAt,
    body: htmlToText(bodyHTML),
  };
}

export function parseIssueHTML(
  html: string,
  owner: string,
  repo: string,
  number: number,
): Record<string, unknown> | undefined {
  const issue = preloadedRepositoryValue(html, "IssueViewerViewQuery", "issue");
  if (
    issue === undefined ||
    issue.__typename === "PullRequest" ||
    issue.number !== number ||
    issue.url !== `https://github.com/${owner}/${repo}/issues/${number}`
  ) {
    return undefined;
  }
  const author = actorJSON(issue.author);
  const labels = labelConnectionJSON(issue.labels);
  const assignees = actorConnectionJSON(issue.assignedActors);
  if (
    typeof issue.title !== "string" ||
    typeof issue.body !== "string" ||
    typeof issue.state !== "string" ||
    typeof issue.createdAt !== "string" ||
    typeof issue.updatedAt !== "string" ||
    author === undefined ||
    labels === undefined ||
    assignees === undefined
  ) {
    return undefined;
  }
  return {
    number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    html_url: issue.url,
    user: author,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    labels,
    assignees,
    milestone: issue.milestone ?? null,
  };
}

export function parseIssueListHTML(
  html: string,
  owner: string,
  repo: string,
  kind: "issue" | "pr",
): Record<string, unknown>[] | undefined {
  const repository = preloadedRepository(html, "IssueIndexPageQuery");
  const search = repository === undefined ? undefined : recordValue(repository.search);
  const pageInfo = search === undefined ? undefined : recordValue(search.pageInfo);
  const edges = search === undefined ? undefined : arrayValue(search.edges);
  if (
    search === undefined ||
    pageInfo === undefined ||
    edges === undefined ||
    pageInfo.hasNextPage === true ||
    (typeof search.issueCount === "number" && search.issueCount !== edges.length)
  ) {
    return undefined;
  }
  const items: Record<string, unknown>[] = [];
  for (const edge of edges) {
    const node = recordValue(recordValue(edge)?.node);
    if (node === undefined) {
      return undefined;
    }
    const expectedType = kind === "pr" ? "PullRequest" : "Issue";
    if (node.__typename !== expectedType || !Number.isInteger(node.number)) {
      return undefined;
    }
    const author = actorJSON(node.author);
    const labels = labelConnectionJSON(node.labels);
    const titleHTML =
      typeof node.titleHTML === "string"
        ? node.titleHTML
        : typeof node.titleHtml === "string"
          ? node.titleHtml
          : undefined;
    if (
      author === undefined ||
      labels === undefined ||
      titleHTML === undefined ||
      typeof node.createdAt !== "string" ||
      typeof node.updatedAt !== "string"
    ) {
      return undefined;
    }
    const number = node.number as number;
    if (kind === "pr") {
      if (
        typeof node.pullRequestState !== "string" ||
        typeof node.isDraft !== "boolean" ||
        (typeof node.closedAt !== "string" && node.closedAt !== null)
      ) {
        return undefined;
      }
      items.push({
        number,
        title: plainHTML(titleHTML),
        state: node.pullRequestState,
        html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
        user: author,
        created_at: node.createdAt,
        updated_at: node.updatedAt,
        closed_at: node.closedAt,
        merged_at: node.pullRequestState === "MERGED" ? node.closedAt : null,
        draft: node.isDraft,
        labels,
      });
      continue;
    }
    const assignees = actorConnectionJSON(node.assignedActors);
    if (
      typeof node.state !== "string" ||
      (typeof node.closedAt !== "string" && node.closedAt !== null) ||
      assignees === undefined
    ) {
      return undefined;
    }
    items.push({
      number,
      title: plainHTML(titleHTML),
      state: node.state,
      html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
      user: author,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      closed_at: node.closedAt,
      labels,
      assignees,
      milestone: node.milestone ?? null,
    });
  }
  return items;
}

export function parsePullRequestHTML(
  html: string,
  owner: string,
  repo: string,
  number: number,
): Record<string, unknown> | undefined {
  const embedded = embeddedAppJSON(html);
  const payload = embedded === undefined ? undefined : recordValue(embedded.payload);
  const layout = payload === undefined ? undefined : recordValue(payload.pullRequestsLayoutRoute);
  const pullRequest = layout === undefined ? undefined : recordValue(layout.pullRequest);
  const repository = layout === undefined ? undefined : recordValue(layout.repository);
  if (
    pullRequest === undefined ||
    repository === undefined ||
    repository.ownerLogin !== owner ||
    repository.name !== repo ||
    pullRequest.number !== number ||
    typeof pullRequest.relayId !== "string" ||
    typeof pullRequest.title !== "string" ||
    typeof pullRequest.state !== "string" ||
    typeof pullRequest.createdTime !== "string" ||
    (typeof pullRequest.closedTime !== "string" && pullRequest.closedTime !== null) ||
    (typeof pullRequest.mergedTime !== "string" && pullRequest.mergedTime !== null) ||
    typeof pullRequest.headBranch !== "string" ||
    typeof pullRequest.headSha !== "string" ||
    typeof pullRequest.baseBranch !== "string"
  ) {
    return undefined;
  }
  return {
    number,
    node_id: pullRequest.relayId,
    title: pullRequest.title,
    state: pullRequest.state,
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    created_at: pullRequest.createdTime,
    closed_at: pullRequest.closedTime,
    merged_at: pullRequest.mergedTime,
    head: { ref: pullRequest.headBranch, sha: pullRequest.headSha },
    base: { ref: pullRequest.baseBranch },
  };
}

export function parseRepositoryNodeIDHTML(html: string): string | undefined {
  const id = preloadedRepository(html, "IssueIndexPageQuery")?.id;
  return typeof id === "string" ? id : undefined;
}

export function parseLabelListHTML(
  html: string,
  owner: string,
  repo: string,
): Record<string, unknown>[] | undefined {
  const repository = preloadedRepository(html, "RepositoryLabelIndexPageQuery");
  const labels = repository === undefined ? undefined : recordValue(repository.labels);
  const edges = labels === undefined ? undefined : arrayValue(labels.edges);
  if (
    labels === undefined ||
    edges === undefined ||
    typeof labels.totalCount !== "number" ||
    labels.totalCount !== edges.length
  ) {
    return undefined;
  }
  const items: Record<string, unknown>[] = [];
  for (const edge of edges) {
    const label = recordValue(recordValue(edge)?.node);
    if (
      label === undefined ||
      typeof label.id !== "string" ||
      typeof label.name !== "string" ||
      typeof label.color !== "string" ||
      (typeof label.description !== "string" && label.description !== null)
    ) {
      return undefined;
    }
    items.push({
      id: label.id,
      name: label.name,
      description: label.description,
      color: label.color,
      url: `https://github.com/${owner}/${repo}/labels/${encodeURIComponent(label.name)}`,
    });
  }
  return sortByNodeID(items);
}

export function parseWorkflowListHTML(
  html: string,
  owner: string,
  repo: string,
): Record<string, unknown>[] | undefined {
  const expectedPrefix = `/${owner}/${repo}/actions/workflows/`;
  const items: Record<string, unknown>[] = [];
  for (const match of html.matchAll(
    /<li\b([^>]*data-test-selector="workflow-rendered"[^>]*)>([\s\S]*?)<\/li>/g,
  )) {
    const id = Number(htmlAttribute(match[1]!, "data-item-id"));
    const body = match[2]!;
    const href = /<a\b[^>]*href="([^"]+)"/.exec(body)?.[1];
    const name = textMatch(body, /<tool-tip\b[^>]*>([\s\S]*?)<\/tool-tip>/);
    if (!Number.isSafeInteger(id) || href === undefined || name === undefined) {
      return undefined;
    }
    const decodedHref = decodeHTML(href);
    if (!decodedHref.startsWith(expectedPrefix)) {
      return undefined;
    }
    const workflowRef = decodeURIComponentSafe(decodedHref.slice(expectedPrefix.length));
    if (workflowRef === "" || workflowRef.includes("?") || workflowRef.includes("#")) {
      return undefined;
    }
    const path = /\.ya?ml$/i.test(workflowRef)
      ? `.github/workflows/${workflowRef}`
      : `dynamic/${workflowRef}`;
    const disabled =
      /<span\b[^>]*class="[^"]*\bcolor-fg-muted\b[^"]*\btext-small\b[^"]*"[^>]*>\s*Disabled\s*<\/span>/i.test(
        body,
      );
    items.push({ id, name, path, state: disabled ? "disabled_manually" : "active" });
  }
  return items.length === 0 ? undefined : items;
}

export function parseWorkflowPageCount(html: string): number | undefined {
  const value = /data-total-pages="([0-9]+)"/.exec(html)?.[1];
  if (value === undefined) {
    return undefined;
  }
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 1 ? count : undefined;
}

function preloadedRepository(html: string, queryName: string): Record<string, unknown> | undefined {
  const embedded = embeddedAppJSON(html);
  const payload = embedded === undefined ? undefined : recordValue(embedded.payload);
  const queries = payload === undefined ? undefined : arrayValue(payload.preloadedQueries);
  if (queries === undefined) {
    return undefined;
  }
  for (const raw of queries) {
    const query = recordValue(raw);
    if (query?.queryName !== queryName) {
      continue;
    }
    const result = recordValue(query.result);
    const data = result === undefined ? undefined : recordValue(result.data);
    return data === undefined ? undefined : recordValue(data.repository);
  }
  return undefined;
}

function preloadedRepositoryValue(
  html: string,
  queryName: string,
  key: string,
): Record<string, unknown> | undefined {
  return recordValue(preloadedRepository(html, queryName)?.[key]);
}

function embeddedAppJSON(html: string): Record<string, unknown> | undefined {
  const raw =
    /<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1];
  if (raw === undefined) {
    return undefined;
  }
  try {
    return recordValue(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function actorJSON(value: unknown): Record<string, unknown> | undefined {
  const actor = recordValue(value);
  if (actor === undefined || typeof actor.id !== "string" || typeof actor.login !== "string") {
    return undefined;
  }
  return {
    id: actor.id,
    login: actor.login,
    name: typeof actor.name === "string" ? actor.name : "",
    is_bot: actor.__typename === "Bot",
  };
}

function actorConnectionJSON(value: unknown): Record<string, unknown>[] | undefined {
  const nodes = connectionNodes(value);
  if (nodes === undefined) {
    return undefined;
  }
  const actors = nodes.map(actorJSON);
  return actors.some((actor) => actor === undefined)
    ? undefined
    : (actors as Record<string, unknown>[]);
}

function labelConnectionJSON(value: unknown): Record<string, unknown>[] | undefined {
  const nodes = connectionNodes(value);
  if (nodes === undefined) {
    return undefined;
  }
  const labels: Record<string, unknown>[] = [];
  for (const raw of nodes) {
    const label = recordValue(raw);
    if (
      label === undefined ||
      typeof label.id !== "string" ||
      typeof label.name !== "string" ||
      typeof label.color !== "string" ||
      (typeof label.description !== "string" && label.description !== null)
    ) {
      return undefined;
    }
    labels.push({
      id: label.id,
      name: label.name,
      description: label.description,
      color: label.color,
    });
  }
  return sortByNodeID(labels);
}

function connectionNodes(value: unknown): unknown[] | undefined {
  const connection = recordValue(value);
  if (connection === undefined) {
    return undefined;
  }
  const pageInfo = recordValue(connection.pageInfo);
  if (pageInfo?.hasNextPage === true) {
    return undefined;
  }
  const nodes = arrayValue(connection.nodes);
  if (nodes !== undefined) {
    return nodes;
  }
  const edges = arrayValue(connection.edges);
  if (edges === undefined) {
    return undefined;
  }
  const out = edges.map((edge) => recordValue(edge)?.node);
  return out.some((node) => node === undefined) ? undefined : out;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function plainHTML(value: string): string {
  return decodeHTML(value.replace(/<[^>]+>/g, "")).trim();
}

function sortByNodeID(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const decoded = items.map((item) => ({
    item,
    bytes: typeof item.id === "string" ? decodedNodeID(item.id) : undefined,
  }));
  if (decoded.some((entry) => entry.bytes === undefined)) {
    return items;
  }
  // GitHub's REST/gh label order follows creation order encoded in GraphQL node IDs.
  decoded.sort((left, right) => compareBytes(left.bytes!, right.bytes!));
  return decoded.map((entry) => entry.item);
}

function decodedNodeID(value: string): Uint8Array | undefined {
  const encoded = value.includes("_") ? value.slice(value.indexOf("_") + 1) : value;
  return base64ToBytesSafe(encoded);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) {
      return left[index]! - right[index]!;
    }
  }
  return left.length - right.length;
}

function collectJobSummaries(
  value: unknown,
  expectedPath: string,
  out: Map<number, ActionsJobSummary>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJobSummaries(item, expectedPath, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (
    Number.isInteger(value.id) &&
    typeof value.displayName === "string" &&
    typeof value.status === "string" &&
    (typeof value.conclusion === "string" || value.conclusion === null) &&
    typeof value.href === "string" &&
    value.href === `${expectedPath}${value.id}`
  ) {
    out.set(value.id as number, {
      id: value.id as number,
      name: value.displayName,
      status: value.status,
      conclusion: value.conclusion,
      href: value.href,
    });
  }
  for (const child of Object.values(value)) {
    collectJobSummaries(child, expectedPath, out);
  }
}

function actionsRunBranch(html: string, owner: string, repo: string): string | undefined {
  const branch = new RegExp(
    `href="/${escapeRegex(owner)}/${escapeRegex(repo)}/tree/refs/heads/([^"]+)"`,
  ).exec(html)?.[1];
  if (branch !== undefined) {
    return decodeURIComponentSafe(branch);
  }
  for (const match of html.matchAll(/<a\b([^>]*)>/g)) {
    const classes = htmlAttribute(match[1]!, "class")?.split(/\s+/);
    if (!classes?.includes("branch-name")) {
      continue;
    }
    const title = htmlAttribute(match[1]!, "title");
    if (title === undefined) {
      continue;
    }
    const separator = title.indexOf(":");
    return separator === -1 ? title : title.slice(separator + 1);
  }
  return undefined;
}

function htmlAttribute(attributes: string, name: string): string | undefined {
  const value = new RegExp(`(?:^|\\s)${escapeRegex(name)}="([^"]*)"`).exec(attributes)?.[1];
  return value === undefined || value === "" ? undefined : decodeHTML(value);
}

function firstTimestamp(items: Record<string, unknown>[], field: string): string | null {
  const values = items
    .map((item) => item[field])
    .filter((value): value is string => typeof value === "string")
    .sort();
  return values[0] ?? null;
}

function runState(label: string): RunState | undefined {
  const normalized = label.trim().toLowerCase();
  if (normalized.includes("completed successfully")) {
    return { status: "completed", conclusion: "success" };
  }
  for (const [needle, conclusion] of [
    ["cancelled", "cancelled"],
    ["failed", "failure"],
    ["timed out", "timed_out"],
    ["action required", "action_required"],
    ["neutral", "neutral"],
    ["skipped", "skipped"],
    ["stale", "stale"],
  ] as const) {
    if (normalized.includes(needle)) {
      return { status: "completed", conclusion };
    }
  }
  for (const status of ["in progress", "queued", "waiting", "pending"] as const) {
    if (normalized.includes(status)) {
      return { status: status.replace(" ", "_"), conclusion: null };
    }
  }
  return undefined;
}

function runEvent(card: string): string | null {
  if (/\bpushed\b/i.test(card)) {
    return "push";
  }
  if (/\bpull request\b/i.test(card)) {
    return "pull_request";
  }
  if (/\bschedule(?:d)?\b/i.test(card)) {
    return "schedule";
  }
  if (/\bworkflow dispatch\b/i.test(card)) {
    return "workflow_dispatch";
  }
  return null;
}

function textMatch(input: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(input)?.[1];
  return value === undefined ? undefined : decodeHTML(value.replace(/<[^>]+>/g, "")).trim();
}

function addDuration(date: string, duration: string | undefined): string | undefined {
  if (duration === undefined) {
    return undefined;
  }
  let seconds = 0;
  let matched = false;
  for (const match of duration.matchAll(/([0-9]+)\s*([hms])/gi)) {
    matched = true;
    const value = Number(match[1]);
    seconds +=
      match[2]!.toLowerCase() === "h"
        ? value * 3600
        : match[2]!.toLowerCase() === "m"
          ? value * 60
          : value;
  }
  const timestamp = Date.parse(date);
  return matched && Number.isFinite(timestamp)
    ? new Date(timestamp + seconds * 1000).toISOString().replace(".000Z", "Z")
    : undefined;
}

function releaseTag(responseURL: string): string | undefined {
  try {
    const match = /\/releases\/tag\/(.+)$/.exec(new URL(responseURL).pathname);
    return match === null ? undefined : decodeURIComponentSafe(match[1]!);
  } catch {
    return undefined;
  }
}

function htmlToText(value: string): string {
  return decodeHTML(
    value
      .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
        const label = String(text)
          .replace(/<[^>]+>/g, "")
          .trim();
        return label === "" ? "" : `[${label}](${decodeHTML(String(href))})`;
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/(?:p|h[1-6]|ul|ol)>/gi, "\n\n")
      .replace(/<code\b[^>]*>/gi, "`")
      .replace(/<\/code>/gi, "`")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHTML(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
