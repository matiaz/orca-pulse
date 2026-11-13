import { clean, isPullUrl } from "../lib/sanitize.mjs";
import { ghGraphql } from "../lib/ghcall.mjs";
import { mergeFields } from "./pulls.mjs";

const PULL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
const OID = /^[0-9a-f]{40}$/;
const METHODS = ["squash", "merge", "rebase"];
const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    pullRequest(number: $number) {
      url state isDraft headRefOid reviewDecision mergeStateStatus
      viewerLatestReview { state commit { oid } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

function parts(url) {
  const match = isPullUrl(url) ? PULL.exec(url) : null;
  if (!match) throw new Error("invalid pull request url");
  return { owner: match[1], name: match[2], number: Number(match[3]) };
}

export function createMerge({ gh }) {
  return {
    async check(pr) {
      const { owner, name, number } = parts(pr?.url);
      const data = await ghGraphql(gh, ["-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`]);
      const repository = data?.repository;
      const fresh = repository?.pullRequest;
      if (!fresh || String(fresh.url).toLowerCase() !== pr.url.toLowerCase()) throw new Error("pull request not found");
      return {
        pr: { ...pr, state: clean(fresh.state, 20), isDraft: fresh.isDraft === true, ...mergeFields(fresh) },
        allowed: {
          squash: repository.squashMergeAllowed === true,
          merge: repository.mergeCommitAllowed === true,
          rebase: repository.rebaseMergeAllowed === true,
        },
      };
    },
    async merge(pr, method) {
      parts(pr?.url);
      if (!METHODS.includes(method)) throw new Error("invalid merge method");
      if (typeof pr.headRefOid !== "string" || !OID.test(pr.headRefOid)) throw new Error("invalid head commit");
      const result = await gh(["pr", "merge", pr.url, `--${method}`, "--match-head-commit", pr.headRefOid]);
      if (result.code !== 0) throw new Error(clean(result.stderr || result.stdout || `gh exited with ${result.code}`, 300));
    },
  };
}
