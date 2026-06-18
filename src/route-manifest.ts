type RouteResource = "core" | "search";

type RouteOptions = {
  cacheable?: boolean;
  largePayload?: boolean;
  fullResponseCap?: boolean;
  search?: boolean;
  logs?: boolean;
  publicApi?: boolean;
  fallback?: RouteFallback;
};

export type RouteFallback = "pool" | "github_public" | "local";

export type RouteCapabilities = {
  publicApi: boolean;
  fallback: RouteFallback;
  anonymousRepoProof: boolean;
};

export type CacheFreshStrategy =
  | { kind: "static"; seconds: number }
  | { kind: "pr" }
  | { kind: "issue" }
  | { kind: "run" }
  | { kind: "run_list" }
  | { kind: "jobs" }
  | { kind: "checks" }
  | { kind: "check_suites" }
  | { kind: "status" }
  | { kind: "status_list" }
  | { kind: "job" }
  | { kind: "pr_state" };

export type RouteCachePolicy = {
  fresh: CacheFreshStrategy;
  staleSeconds: number;
  terminalStaleSeconds?: number;
};

type RouteRule<Kind extends string> = {
  id: string;
  template: string;
  routeKeyTemplate: string;
  example: string;
  pattern: RegExp;
  kind: Kind;
  resource: RouteResource;
  cacheable: boolean;
  largePayload: boolean;
  fullResponseCap: boolean;
  search: boolean;
  logs: boolean;
  capabilities: RouteCapabilities;
};

const routeParameters = {
  owner: "[A-Za-z0-9_.-]+",
  repo: "[A-Za-z0-9_.-]+",
  org: "[A-Za-z0-9_.-]+",
  login: "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\\[bot\\]|%5[Bb]bot%5[Dd])?",
  number: "[0-9]+",
  sha: "[0-9A-Fa-f]{7,64}",
  id: "[0-9]+",
  tag: "[^/?#]+",
  gistId: "[0-9A-Fa-f]+",
  slug: "[A-Za-z0-9_.-]+",
  template: "[^/?#]+",
  compare: "[^/?#]+",
  contentPath: ".+",
  readmeDir: ".+",
  label: "[^/?#]+",
  branch: "[^/?#]+",
  gitRef: ".+",
  workflow: "[^/?#]+",
} as const;

const routeParameterExamples: Record<RouteParameter, string> = {
  owner: "openclaw",
  repo: "octopool",
  org: "openclaw",
  login: "octocat",
  number: "42",
  sha: "0123456789abcdef0123456789abcdef01234567",
  id: "42",
  tag: "v1.2.3",
  gistId: "abc123",
  slug: "mit",
  template: "Go",
  compare: "main...feature",
  contentPath: "src/index.ts",
  readmeDir: "docs",
  label: "bug",
  branch: "main",
  gitRef: "heads/main",
  workflow: "ci.yml",
};

export const ROUTE_LOGIN_PATTERN = routeParameters.login;

type RouteParameter = keyof typeof routeParameters;

function route<const Kind extends string>(
  template: string,
  kind: Kind,
  resource: RouteResource = "core",
  options: RouteOptions = {},
): RouteRule<Kind> {
  return {
    id: `${kind}:${template}`,
    template,
    routeKeyTemplate: normalizeRouteKeyTemplate(template),
    example: routeExample(template),
    pattern: compileRoutePattern(template),
    kind,
    resource,
    cacheable: options.cacheable ?? true,
    largePayload: options.largePayload ?? false,
    fullResponseCap: options.fullResponseCap ?? false,
    search: options.search ?? false,
    logs: options.logs ?? false,
    capabilities: {
      publicApi: options.publicApi ?? true,
      fallback: options.fallback ?? "pool",
      anonymousRepoProof:
        template.includes("{owner}") && template.includes("{repo}") && resource !== "search",
    },
  };
}

function localRoute<const Kind extends string>(
  template: string,
  kind: Kind,
  resource: RouteResource = "core",
  options: RouteOptions = {},
): RouteRule<Kind> {
  return route(template, kind, resource, { ...options, fallback: "local" });
}

function normalizeRouteKeyTemplate(template: string): string {
  return template
    .replace(/^\/users\/\{login\}/, "/users/:login")
    .replace(/^\/orgs\/\{org\}/, "/orgs/:org")
    .replace(/\/gists\/\{gistId\}/g, "/gists/:id")
    .replace(/\/pulls\/\{number\}/g, "/pulls/:number")
    .replace(/\/issues\/\{number\}/g, "/issues/:number")
    .replace(/\/comments\/\{id\}/g, "/comments/:id")
    .replace(/\/commits\/\{sha\}/g, "/commits/:sha")
    .replace(/\/actions\/runs\/\{id\}/g, "/actions/runs/:id")
    .replace(/\/actions\/jobs\/\{id\}/g, "/actions/jobs/:id")
    .replace(/\/check-runs\/\{id\}/g, "/check-runs/:id")
    .replace(/\/milestones\/\{id\}/g, "/milestones/:id")
    .replace(/\/git\/(blobs|commits|trees)\/\{sha\}/g, "/git/$1/:sha")
    .replace(/\/git\/ref\/\{gitRef\}/g, "/git/ref/:ref")
    .replace(/\/git\/matching-refs\/\{gitRef\}/g, "/git/matching-refs/:ref")
    .replace(/\/actions\/workflows\/\{workflow\}\/runs/g, "/actions/workflows/:workflow/runs")
    .replace(/\/actions\/workflows\/\{workflow\}/g, "/actions/workflows/:workflow")
    .replace(/\/releases\/assets\/\{id\}/g, "/releases/assets/:id")
    .replace(/\/releases\/\{id\}/g, "/releases/:id");
}

export function routeKeyForMatch(
  method: string,
  route: RouteManifestEntry,
  match: RegExpExecArray,
): string {
  const path = route.routeKeyTemplate.replace(
    /\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (_token, name: string) => {
      const value = match.groups?.[name];
      if (value === undefined) {
        throw new Error(`Missing ${name} route parameter for ${route.id}`);
      }
      return value;
    },
  );
  return `${method.toUpperCase()} ${path}`;
}

function routeExample(template: string): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_token, rawName: string) => {
    const example = routeParameterExamples[rawName as RouteParameter];
    if (example === undefined) {
      throw new Error(`Unknown route parameter: ${rawName}`);
    }
    return example;
  });
}

function compileRoutePattern(template: string): RegExp {
  const source = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_token, rawName: string) => {
    const name = rawName as RouteParameter;
    const pattern = routeParameters[name];
    if (pattern === undefined) {
      throw new Error(`Unknown route parameter: ${rawName}`);
    }
    return `(?<${name}>${pattern})`;
  });
  if (/\{[A-Za-z]/.test(source)) {
    throw new Error(`Invalid route template: ${template}`);
  }
  return new RegExp(`^${source}$`);
}

export const ROUTES = [
  route("/users/{login}", "user_view", "core", {
    publicApi: false,
    fallback: "github_public",
  }),
  localRoute("/users/{login}/repos", "user_repo_list"),
  localRoute("/users/{login}/orgs", "user_org_list"),
  localRoute("/users/{login}/gists", "user_gist_list"),
  localRoute("/users/{login}/followers", "user_follower_list"),
  localRoute("/users/{login}/following", "user_following_list"),
  localRoute("/users/{login}/events", "user_event_list"),
  localRoute("/users/{login}/received_events", "user_received_event_list"),
  localRoute("/users/{login}/keys", "user_key_list"),
  localRoute("/users/{login}/gpg_keys", "user_gpg_key_list"),
  localRoute("/orgs/{org}/repos", "org_repo_list"),
  localRoute("/orgs/{org}/events", "org_event_list"),
  localRoute("/orgs/{org}/public_members", "org_public_member_list"),
  localRoute("/orgs/{org}/public_members/{login}", "org_public_member_view"),
  localRoute("/gists/{gistId}", "gist_view"),
  localRoute("/emojis", "emoji_list"),
  localRoute("/meta", "github_meta"),
  localRoute("/licenses", "license_list"),
  localRoute("/licenses/{slug}", "license_view"),
  localRoute("/gitignore/templates", "gitignore_template_list"),
  localRoute("/gitignore/templates/{template}", "gitignore_template_view"),
  route("/repos/{owner}/{repo}", "repo_view"),
  route("/repos/{owner}/{repo}/commits", "commit_list"),
  route("/repos/{owner}/{repo}/commits/{sha}", "commit_view"),
  route("/repos/{owner}/{repo}/commits/{sha}/comments", "commit_comments"),
  route("/repos/{owner}/{repo}/commits/{sha}/pulls", "commit_pulls"),
  route("/repos/{owner}/{repo}/commits/{sha}/branches-where-head", "commit_branches_where_head"),
  route("/repos/{owner}/{repo}/commits/{sha}/statuses", "commit_statuses"),
  route("/repos/{owner}/{repo}/comments/{id}", "repo_comment"),
  route("/repos/{owner}/{repo}/compare/{compare}", "compare"),
  route("/repos/{owner}/{repo}/contents/{contentPath}", "contents"),
  route("/repos/{owner}/{repo}/readme", "repo_readme"),
  route("/repos/{owner}/{repo}/readme/{readmeDir}", "repo_readme"),
  route("/repos/{owner}/{repo}/pulls/{number}", "pr_view"),
  route("/repos/{owner}/{repo}/pulls", "pr_list"),
  route("/repos/{owner}/{repo}/pulls/{number}/files", "pr_files"),
  route("/repos/{owner}/{repo}/pulls/{number}/commits", "pr_commits"),
  route("/repos/{owner}/{repo}/pulls/{number}/comments", "pr_review_comments"),
  route("/repos/{owner}/{repo}/pulls/comments", "pr_review_comment_list"),
  route("/repos/{owner}/{repo}/pulls/comments/{id}", "pr_review_comment_view"),
  route("/repos/{owner}/{repo}/pulls/comments/{id}/reactions", "pr_review_comment_reactions"),
  route("/repos/{owner}/{repo}/pulls/{number}/reviews", "pr_reviews"),
  route("/repos/{owner}/{repo}/pulls/{number}/reviews/{id}", "pr_review_view"),
  route(
    "/repos/{owner}/{repo}/pulls/{number}/reviews/{id}/comments",
    "pr_review_comments_for_review",
  ),
  route("/repos/{owner}/{repo}/pulls/{number}/requested_reviewers", "pr_requested_reviewers"),
  route("/repos/{owner}/{repo}/commits/{sha}/check-runs", "commit_check_runs"),
  route("/repos/{owner}/{repo}/commits/{sha}/check-suites", "commit_check_suites"),
  route("/repos/{owner}/{repo}/commits/{sha}/status", "commit_status"),
  route("/repos/{owner}/{repo}/statuses/{sha}", "ref_statuses"),
  route("/repos/{owner}/{repo}/actions/runs", "run_list", "core", {
    fullResponseCap: true,
  }),
  route("/repos/{owner}/{repo}/actions/runs/{id}", "run_view"),
  route("/repos/{owner}/{repo}/actions/runs/{id}/jobs", "run_jobs"),
  route("/repos/{owner}/{repo}/actions/runs/{id}/artifacts", "run_artifacts"),
  route("/repos/{owner}/{repo}/actions/jobs/{id}", "job_view"),
  route("/repos/{owner}/{repo}/actions/jobs/{id}/logs", "job_logs", "core", {
    largePayload: true,
    logs: true,
    publicApi: false,
  }),
  route("/repos/{owner}/{repo}/check-runs/{id}/annotations", "check_run_annotations"),
  route("/repos/{owner}/{repo}/issues/{number}", "issue_view"),
  route("/repos/{owner}/{repo}/issues", "issue_list"),
  route("/repos/{owner}/{repo}/issues/{number}/comments", "issue_comments"),
  route("/repos/{owner}/{repo}/issues/comments", "issue_comment_list"),
  route("/repos/{owner}/{repo}/issues/comments/{id}", "issue_comment_view"),
  route("/repos/{owner}/{repo}/issues/comments/{id}/reactions", "issue_comment_reactions"),
  route("/repos/{owner}/{repo}/issues/{number}/events", "issue_events"),
  route("/repos/{owner}/{repo}/issues/events", "issue_event_list"),
  route("/repos/{owner}/{repo}/issues/events/{id}", "issue_event_view"),
  route("/repos/{owner}/{repo}/issues/{number}/labels", "issue_labels"),
  route("/repos/{owner}/{repo}/issues/{number}/reactions", "issue_reactions"),
  route("/repos/{owner}/{repo}/issues/{number}/timeline", "issue_timeline"),
  route("/repos/{owner}/{repo}/assignees", "assignee_list"),
  route("/repos/{owner}/{repo}/assignees/{login}", "assignee_view"),
  route("/repos/{owner}/{repo}/labels", "label_list"),
  route("/repos/{owner}/{repo}/labels/{label}", "label_view"),
  route("/repos/{owner}/{repo}/milestones", "milestone_list"),
  route("/repos/{owner}/{repo}/milestones/{id}", "milestone_view"),
  route("/repos/{owner}/{repo}/branches", "branch_list"),
  route("/repos/{owner}/{repo}/branches/{branch}", "branch_view"),
  route("/repos/{owner}/{repo}/tags", "tag_list"),
  route("/repos/{owner}/{repo}/languages", "repo_languages"),
  route("/repos/{owner}/{repo}/contributors", "repo_contributors"),
  route("/repos/{owner}/{repo}/license", "repo_license"),
  route("/repos/{owner}/{repo}/topics", "repo_topics"),
  route("/repos/{owner}/{repo}/community/profile", "community_profile"),
  route("/repos/{owner}/{repo}/forks", "fork_list"),
  route("/repos/{owner}/{repo}/stargazers", "stargazer_list"),
  route("/repos/{owner}/{repo}/subscribers", "subscriber_list"),
  route("/repos/{owner}/{repo}/deployments", "deployment_list"),
  route("/repos/{owner}/{repo}/events", "repo_event_list"),
  route("/networks/{owner}/{repo}/events", "network_event_list"),
  route("/repos/{owner}/{repo}/stats/contributors", "repo_stats_contributors"),
  route("/repos/{owner}/{repo}/stats/commit_activity", "repo_stats_commit_activity"),
  route("/repos/{owner}/{repo}/stats/code_frequency", "repo_stats_code_frequency"),
  route("/repos/{owner}/{repo}/stats/participation", "repo_stats_participation"),
  route("/repos/{owner}/{repo}/stats/punch_card", "repo_stats_punch_card"),
  route("/repos/{owner}/{repo}/git/blobs/{sha}", "git_blob"),
  route("/repos/{owner}/{repo}/git/commits/{sha}", "git_commit"),
  route("/repos/{owner}/{repo}/git/trees/{sha}", "git_tree"),
  route("/repos/{owner}/{repo}/git/ref/{gitRef}", "git_ref"),
  route("/repos/{owner}/{repo}/git/matching-refs/{gitRef}", "git_matching_refs"),
  route("/repos/{owner}/{repo}/actions/workflows", "workflow_list"),
  route("/repos/{owner}/{repo}/actions/workflows/{workflow}", "workflow_view"),
  route("/repos/{owner}/{repo}/actions/workflows/{workflow}/runs", "workflow_run_list", "core", {
    fullResponseCap: true,
  }),
  localRoute("/repos/{owner}/{repo}/releases", "release_list", "core", {
    publicApi: false,
  }),
  localRoute("/repos/{owner}/{repo}/releases/latest", "release_latest", "core", {
    publicApi: false,
  }),
  localRoute("/repos/{owner}/{repo}/releases/tags/{tag}", "release_view", "core", {
    publicApi: false,
  }),
  localRoute("/repos/{owner}/{repo}/releases/{id}", "release_view", "core", {
    publicApi: false,
  }),
  localRoute("/repos/{owner}/{repo}/releases/{id}/assets", "release_assets"),
  localRoute("/repos/{owner}/{repo}/releases/assets/{id}", "release_asset"),
  route("/search/issues", "search_issues", "search", { search: true }),
  route("/search/code", "search_code", "search", { search: true, publicApi: false }),
  route("/search/commits", "search_commits", "search", { search: true }),
  localRoute("/search/repositories", "search_repositories", "search", { search: true }),
  route("/rate_limit", "rate_limit", "core", { publicApi: false, cacheable: false }),
] as const;

export type RouteKind = (typeof ROUTES)[number]["kind"];
export type RouteManifestEntry = (typeof ROUTES)[number];

const capabilitiesByKind = new Map<RouteKind, RouteCapabilities>();
for (const route of ROUTES) {
  const existing = capabilitiesByKind.get(route.kind);
  if (existing !== undefined && !sameCapabilities(existing, route.capabilities)) {
    throw new Error(`Inconsistent capabilities for route kind: ${route.kind}`);
  }
  capabilitiesByKind.set(route.kind, route.capabilities);
}

export function capabilitiesForRouteKind(kind: RouteKind): RouteCapabilities {
  const capabilities = capabilitiesByKind.get(kind);
  if (capabilities === undefined) {
    throw new Error(`Unknown route kind: ${kind}`);
  }
  return capabilities;
}

function sameCapabilities(left: RouteCapabilities, right: RouteCapabilities): boolean {
  return (
    left.publicApi === right.publicApi &&
    left.fallback === right.fallback &&
    left.anonymousRepoProof === right.anonymousRepoProof
  );
}

export function cachePolicyForRouteKind(kind: RouteKind): RouteCachePolicy {
  return {
    fresh: freshCacheStrategy(kind),
    staleSeconds: staleCacheSeconds(kind),
    ...(terminalCIRoute(kind) ? { terminalStaleSeconds: 86_400 } : {}),
  };
}

function freshCacheStrategy(kind: RouteKind): CacheFreshStrategy {
  switch (kind) {
    case "user_view":
      return staticCache(3_600);
    case "repo_view":
    case "org_repo_list":
    case "user_repo_list":
      return staticCache(600);
    case "user_org_list":
    case "user_gist_list":
    case "user_follower_list":
    case "user_following_list":
    case "user_event_list":
    case "user_received_event_list":
    case "user_key_list":
    case "user_gpg_key_list":
    case "org_event_list":
    case "org_public_member_list":
    case "org_public_member_view":
    case "gist_view":
    case "emoji_list":
    case "github_meta":
    case "license_list":
    case "license_view":
    case "gitignore_template_list":
    case "gitignore_template_view":
    case "repo_readme":
    case "contents":
    case "release_view":
    case "workflow_list":
    case "workflow_view":
    case "tag_list":
    case "repo_languages":
    case "repo_contributors":
    case "repo_license":
    case "repo_topics":
    case "community_profile":
    case "fork_list":
    case "stargazer_list":
    case "subscriber_list":
    case "repo_event_list":
    case "network_event_list":
    case "deployment_list":
    case "release_assets":
    case "release_asset":
    case "repo_stats_contributors":
    case "repo_stats_commit_activity":
    case "repo_stats_code_frequency":
    case "repo_stats_participation":
    case "repo_stats_punch_card":
      return staticCache(3_600);
    case "commit_list":
    case "commit_pulls":
    case "commit_branches_where_head":
    case "compare":
    case "pr_commits":
    case "pr_review_comments":
    case "pr_review_comment_list":
    case "pr_review_comment_view":
    case "pr_reviews":
    case "pr_review_view":
    case "pr_review_comments_for_review":
    case "pr_requested_reviewers":
    case "commit_comments":
    case "repo_comment":
    case "issue_comments":
    case "issue_comment_list":
    case "issue_comment_view":
    case "issue_events":
    case "issue_event_list":
    case "issue_event_view":
    case "issue_labels":
    case "issue_timeline":
    case "label_list":
    case "label_view":
    case "milestone_list":
    case "milestone_view":
    case "issue_reactions":
    case "issue_comment_reactions":
    case "pr_review_comment_reactions":
    case "assignee_list":
    case "assignee_view":
      return staticCache(300);
    case "commit_view":
    case "git_blob":
    case "git_commit":
    case "git_tree":
      return staticCache(86_400);
    case "release_latest":
    case "release_list":
      return staticCache(300);
    case "pr_view":
      return { kind: "pr" };
    case "pr_list":
    case "issue_list":
      return staticCache(60);
    case "issue_view":
      return { kind: "issue" };
    case "branch_list":
    case "branch_view":
    case "git_ref":
    case "git_matching_refs":
      return staticCache(120);
    case "run_view":
      return { kind: "run" };
    case "run_list":
    case "workflow_run_list":
      return { kind: "run_list" };
    case "run_jobs":
      return { kind: "jobs" };
    case "commit_check_runs":
      return { kind: "checks" };
    case "commit_check_suites":
      return { kind: "check_suites" };
    case "commit_status":
      return { kind: "status" };
    case "commit_statuses":
    case "ref_statuses":
      return { kind: "status_list" };
    case "job_view":
      return { kind: "job" };
    case "pr_files":
      return { kind: "pr_state" };
    case "search_issues":
    case "search_code":
    case "search_commits":
    case "search_repositories":
      return staticCache(120);
    case "run_artifacts":
    case "job_logs":
    case "check_run_annotations":
    case "rate_limit":
      return staticCache(60);
    default:
      return assertNever(kind);
  }
}

function staleCacheSeconds(kind: RouteKind): number {
  switch (kind) {
    case "run_view":
    case "run_list":
    case "workflow_run_list":
    case "run_jobs":
    case "commit_check_runs":
    case "commit_check_suites":
    case "commit_status":
    case "commit_statuses":
    case "ref_statuses":
    case "job_view":
    case "git_ref":
    case "git_matching_refs":
      return 300;
    case "pr_list":
    case "issue_list":
    case "org_repo_list":
    case "user_repo_list":
      return 600;
    case "pr_view":
    case "issue_view":
    case "pr_files":
    case "pr_commits":
    case "pr_review_comments":
    case "pr_review_comment_list":
    case "pr_review_comment_view":
    case "pr_reviews":
    case "pr_review_view":
    case "pr_review_comments_for_review":
    case "pr_requested_reviewers":
    case "commit_comments":
    case "commit_pulls":
    case "commit_branches_where_head":
    case "repo_comment":
    case "issue_comments":
    case "issue_comment_list":
    case "issue_comment_view":
    case "issue_events":
    case "issue_event_list":
    case "issue_event_view":
    case "issue_labels":
    case "issue_timeline":
    case "label_list":
    case "label_view":
    case "milestone_list":
    case "milestone_view":
    case "issue_reactions":
    case "issue_comment_reactions":
    case "pr_review_comment_reactions":
    case "assignee_list":
    case "assignee_view":
    case "repo_event_list":
    case "network_event_list":
    case "org_event_list":
    case "deployment_list":
      return 3_600;
    case "repo_view":
    case "user_view":
    case "user_org_list":
    case "user_gist_list":
    case "user_follower_list":
    case "user_following_list":
    case "user_event_list":
    case "user_received_event_list":
    case "user_key_list":
    case "user_gpg_key_list":
    case "org_public_member_list":
    case "org_public_member_view":
    case "gist_view":
    case "emoji_list":
    case "github_meta":
    case "license_list":
    case "license_view":
    case "gitignore_template_list":
    case "gitignore_template_view":
    case "repo_readme":
    case "branch_list":
    case "branch_view":
    case "tag_list":
    case "repo_languages":
    case "repo_contributors":
    case "repo_license":
    case "repo_topics":
    case "community_profile":
    case "fork_list":
    case "stargazer_list":
    case "subscriber_list":
    case "commit_list":
    case "compare":
    case "contents":
    case "release_list":
    case "release_view":
    case "release_latest":
    case "release_assets":
    case "release_asset":
    case "repo_stats_contributors":
    case "repo_stats_commit_activity":
    case "repo_stats_code_frequency":
    case "repo_stats_participation":
    case "repo_stats_punch_card":
      return 7_200;
    case "commit_view":
    case "git_blob":
    case "git_commit":
    case "git_tree":
      return 86_400;
    case "run_artifacts":
    case "job_logs":
    case "check_run_annotations":
    case "workflow_list":
    case "workflow_view":
    case "search_issues":
    case "search_code":
    case "search_commits":
    case "search_repositories":
    case "rate_limit":
      return 1_800;
    default:
      return assertNever(kind);
  }
}

function terminalCIRoute(kind: RouteKind): boolean {
  switch (kind) {
    case "run_view":
    case "run_jobs":
    case "commit_check_runs":
    case "commit_check_suites":
    case "commit_status":
    case "commit_statuses":
    case "ref_statuses":
    case "job_view":
      return true;
    default:
      return false;
  }
}

function staticCache(seconds: number): CacheFreshStrategy {
  return { kind: "static", seconds };
}

function assertNever(value: never): never {
  throw new Error(`Missing cache policy for route kind: ${String(value)}`);
}
