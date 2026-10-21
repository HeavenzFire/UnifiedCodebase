import test from "node:test";
import assert from "node:assert/strict";
import { readGitHubMetadataTask } from "./github-metadata-worker.mjs";

function response(payload, { ok = true, status = 200, link = "" } = {}) {
  return {
    ok,
    status,
    headers: { get: name => name.toLowerCase() === "link" ? link : null },
    json: async () => payload,
  };
}

test("lists bounded GitHub metadata through fixed HTTPS API and projects safe fields", async () => {
  let request;
  const report = await readGitHubMetadataTask({
    metadata: { operation: "list", owner: "HeavenzFire", page: 2, perPage: 2, url: "http://attacker.invalid" },
  }, {
    env: { HEAVENZFIRE_GITHUB_READ_TOKEN: "read-only-test-token" },
    now: () => "2026-10-21T00:00:00.000Z",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response([
        { full_name: "HeavenzFire/Repo-A", name: "Repo-A", visibility: "public", archived: false, default_branch: "main", updated_at: "2026-10-20T00:00:00Z", html_url: "https://github.com/HeavenzFire/Repo-A", stargazers_count: 2, forks_count: 1, open_issues_count: 3, language: "JavaScript", secret: "must not escape" },
        { full_name: "HeavenzFire/Repo-B", name: "Repo-B", private: false },
        { full_name: "HeavenzFire/Private-Repo", name: "Private-Repo", private: true, visibility: "private" },
      ], { link: '<https://api.github.com/users/HeavenzFire/repos?page=3>; rel="next"' });
    },
  });
  const url = new URL(request.url);
  assert.equal(url.origin, "https://api.github.com");
  assert.equal(url.pathname, "/users/HeavenzFire/repos");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("per_page"), "2");
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.headers.authorization, "Bearer read-only-test-token");
  assert.equal(report.count, 2);
  assert.equal(report.repositories.some(repository => repository.visibility === "private"), false);
  assert.equal(report.hasMore, true);
  assert.equal(report.repositories[0].full_name, "HeavenzFire/Repo-A");
  assert.equal("secret" in report.repositories[0], false);
  assert.equal(report.repositories[1].visibility, "public");
});

test("gets one repository using an allowlisted path and no token leakage", async () => {
  let request;
  const report = await readGitHubMetadataTask({ metadata: { operation: "get", owner: "HeavenzFire", repo: "UnifiedCodebase" } }, {
    env: {},
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response({ full_name: "HeavenzFire/UnifiedCodebase", name: "UnifiedCodebase", private: false, archived: false, default_branch: "main", stargazers_count: 5 });
    },
  });
  assert.equal(new URL(request.url).pathname, "/repos/HeavenzFire/UnifiedCodebase");
  assert.equal(request.init.method, "GET");
  assert.equal("authorization" in request.init.headers, false);
  assert.equal(report.repository.full_name, "HeavenzFire/UnifiedCodebase");
  assert.equal(report.repository.visibility, "public");
});

test("rejects arbitrary operations, invalid names, invalid paging, and API errors", async () => {
  const unused = async () => { throw new Error("fetch must not be called"); };
  await assert.rejects(readGitHubMetadataTask({ metadata: { operation: "delete" } }, { fetchImpl: unused }), /operation must be list or get/);
  await assert.rejects(readGitHubMetadataTask({ metadata: { owner: "../attacker" } }, { fetchImpl: unused }), /valid GitHub owner/);
  await assert.rejects(readGitHubMetadataTask({ metadata: { page: 11 } }, { fetchImpl: unused }), /page must be an integer/);
  await assert.rejects(readGitHubMetadataTask({ metadata: { operation: "get", repo: "../secret" } }, { fetchImpl: unused }), /valid GitHub owner or repository/);
  await assert.rejects(readGitHubMetadataTask({ metadata: { operation: "get", repo: "Private-Repo" } }, { fetchImpl: async () => response({ full_name: "HeavenzFire/Private-Repo", private: true, visibility: "private" }) }), /Private repository metadata is not exposed/);
  await assert.rejects(readGitHubMetadataTask({ metadata: {} }, { fetchImpl: async () => response({}, { ok: false, status: 403 }) }), /status 403/);
});
