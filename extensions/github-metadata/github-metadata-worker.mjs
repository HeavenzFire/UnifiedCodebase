const API_BASE = "https://api.github.com";
const OWNER_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

function validateName(value, field, pattern) {
  if (typeof value !== "string" || !pattern.test(value) || value === "." || value === "..") {
    throw new TypeError(field + " must be a valid GitHub owner or repository name.");
  }
  return value;
}

function projectRepository(repository) {
  if (!repository || typeof repository !== "object" || typeof repository.full_name !== "string") {
    throw new TypeError("GitHub returned a repository record with an invalid shape.");
  }
  return {
    full_name: repository.full_name,
    name: repository.name ?? null,
    visibility: repository.visibility ?? (repository.private ? "private" : "public"),
    archived: Boolean(repository.archived),
    default_branch: repository.default_branch ?? null,
    updated_at: repository.updated_at ?? null,
    html_url: repository.html_url ?? null,
    stargazers_count: Number.isInteger(repository.stargazers_count) ? repository.stargazers_count : 0,
    forks_count: Number.isInteger(repository.forks_count) ? repository.forks_count : 0,
    open_issues_count: Number.isInteger(repository.open_issues_count) ? repository.open_issues_count : 0,
    language: repository.language ?? null,
  };
}

/** Read-only GitHub REST adapter. Request destinations and HTTP method are fixed in code. */
export async function readGitHubMetadataTask(task, {
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  const metadata = task?.metadata ?? {};
  const operation = metadata.operation ?? "list";
  if (operation !== "list" && operation !== "get") throw new TypeError("operation must be list or get.");
  const owner = validateName(metadata.owner ?? env.HEAVENZFIRE_GITHUB_OWNER ?? "HeavenzFire", "owner", OWNER_PATTERN);
  let url;
  if (operation === "get") {
    const repository = validateName(metadata.repo, "repo", REPOSITORY_PATTERN);
    url = new URL("/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repository), API_BASE);
  } else {
    const page = metadata.page ?? 1;
    const perPage = metadata.perPage ?? 30;
    if (!Number.isInteger(page) || page < 1 || page > 10) throw new RangeError("page must be an integer from 1 through 10.");
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new RangeError("perPage must be an integer from 1 through 100.");
    url = new URL("/users/" + encodeURIComponent(owner) + "/repos", API_BASE);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "updated");
    url.searchParams.set("direction", "desc");
  }

  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "HeavenzFire-UnifiedField-read-only-metadata",
  };
  const token = env.HEAVENZFIRE_GITHUB_READ_TOKEN;
  if (typeof token === "string" && token.trim()) headers.authorization = "Bearer " + token.trim();

  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!response || response.ok !== true) {
    const status = Number.isInteger(response?.status) ? response.status : "unknown";
    throw new Error("GitHub metadata API request failed with status " + status + ".");
  }
  const payload = await response.json();
  const fetchedAt = now();
  if (typeof fetchedAt !== "string" || Number.isNaN(Date.parse(fetchedAt))) {
    throw new TypeError("now must return a valid date string.");
  }
  if (operation === "get") {
    return {
      schema: "heavenzfire.github-metadata-report.v1",
      operation,
      fetchedAt,
      repository: projectRepository(payload),
    };
  }
  if (!Array.isArray(payload)) throw new TypeError("GitHub repository list response must be an array.");
  return {
    schema: "heavenzfire.github-metadata-report.v1",
    operation,
    owner,
    page: metadata.page ?? 1,
    perPage: metadata.perPage ?? 30,
    fetchedAt,
    count: payload.length,
    hasMore: String(response.headers?.get?.("link") ?? "").includes('rel="next"'),
    repositories: payload.map(projectRepository),
  };
}
