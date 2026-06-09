/**
 * PR Hygiene Pre-flight Gate
 * ==========================
 * Mechanical enforcement of the PR discipline rules defined in:
 *   - agent-souls/BUILDER.md   → "Heartbeat Exit Check" & "Commit Budget"
 *   - agent-souls/CTO.md       → "Heartbeat Exit Check" & "Commit Budget"
 *   - shared-knowledge/AGENT_ACCOUNTABILITY.md → "CI Enforcement"
 *
 * Called inside executeRun() BEFORE the adapter is invoked. If the agent's
 * GitHub user has open PRs with failing CI or exceeds the open-PR budget,
 * this gate overrides the task context so the agent is forced to fix its
 * existing PRs instead of picking up new work.
 *
 * This complements the GitHub Actions workflow (agent-pr-gate.yml) which
 * blocks PR *merging* — this gate blocks new *work assignment* at the
 * heartbeat level.
 */

import { logger } from "../middleware/logger.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum open PRs before new work is blocked entirely. */
const MAX_OPEN_PRS = 3;

/** GitHub username whose PRs are subject to this gate. */
const GATED_GITHUB_USERNAME = "legacykeeperops";

/** How long to wait for the GitHub API before giving up (fail-open). */
const GITHUB_API_TIMEOUT_MS = 15_000;

/** Hostname for GitHub API calls. */
const GITHUB_HOSTNAME = "github.com";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrHygieneResult {
  /** Whether the gate ran successfully (false = fail-open, no override). */
  checked: boolean;
  /** Total open PRs for the gated user. */
  totalOpenPRs: number;
  /** PRs with at least one failing CI check. */
  failingPRs: Array<{ number: number; title: string; url: string }>;
  /** If non-null, the agent's task should be replaced with this markdown. */
  overrideTaskMarkdown: string | null;
  /** Human-readable reason for the gate decision. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Core gate logic
// ---------------------------------------------------------------------------

/**
 * Query GitHub for the gated user's open PRs and their CI status.
 * Returns an override task if PR hygiene is bad, or null if the agent
 * should proceed with its normal assignment.
 *
 * This function is designed to **fail open**: if the GitHub API is
 * unreachable or returns unexpected data, the agent proceeds normally
 * and a warning is logged.
 *
 * @param repoOwner  - GitHub org/user that owns the repo (e.g. "Legacy-Keeper-Corp")
 * @param repoName   - Repository name (e.g. "Legacy-Keeper-Main-9b891f02")
 * @param options     - Optional overrides for testing.
 */
export async function checkPrHygiene(
  repoOwner: string,
  repoName: string,
  options?: {
    githubToken?: string;
    githubUsername?: string;
    maxOpenPRs?: number;
  },
): Promise<PrHygieneResult> {
  const githubUsername = options?.githubUsername ?? GATED_GITHUB_USERNAME;
  const maxOpen = options?.maxOpenPRs ?? MAX_OPEN_PRS;
  const apiBase = gitHubApiBase(GITHUB_HOSTNAME);

  const failOpen = (reason: string): PrHygieneResult => {
    logger.warn({ reason, githubUsername, repoOwner, repoName }, "pr-hygiene-gate: failing open");
    return {
      checked: false,
      totalOpenPRs: 0,
      failingPRs: [],
      overrideTaskMarkdown: null,
      reason: `fail-open: ${reason}`,
    };
  };

  try {
    // ── 1. List open PRs by the gated user ─────────────────────────────
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "paperclip-pr-hygiene-gate",
    };
    if (options?.githubToken) {
      headers.Authorization = `token ${options.githubToken}`;
    }

    const prsResponse = await Promise.race([
      ghFetch(`${apiBase}/repos/${repoOwner}/${repoName}/pulls?state=open&per_page=100`, { headers }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("GitHub API timeout")), GITHUB_API_TIMEOUT_MS),
      ),
    ]);

    if (!prsResponse.ok) {
      return failOpen(`GitHub API returned ${prsResponse.status} listing PRs`);
    }

    const allPRs = (await prsResponse.json()) as Array<{
      number: number;
      title: string;
      html_url: string;
      user: { login: string } | null;
      head: { sha: string };
    }>;

    const agentPRs = allPRs.filter(
      (pr) => pr.user?.login === githubUsername,
    );
    const totalOpenPRs = agentPRs.length;

    logger.info(
      { githubUsername, repoOwner, repoName, totalOpenPRs },
      "pr-hygiene-gate: checked open PRs",
    );

    if (totalOpenPRs === 0) {
      return {
        checked: true,
        totalOpenPRs: 0,
        failingPRs: [],
        overrideTaskMarkdown: null,
        reason: "no open PRs",
      };
    }

    // ── 2. Check CI status for each agent PR ───────────────────────────
    const failingPRs: PrHygieneResult["failingPRs"] = [];

    for (const pr of agentPRs) {
      try {
        const checksResponse = await ghFetch(
          `${apiBase}/repos/${repoOwner}/${repoName}/commits/${pr.head.sha}/check-runs?per_page=100`,
          { headers },
        );
        if (!checksResponse.ok) continue;

        const checksData = (await checksResponse.json()) as {
          check_runs: Array<{ conclusion: string | null; status: string }>;
        };
        const hasFailing = checksData.check_runs.some(
          (run) => run.conclusion === "failure",
        );
        if (hasFailing) {
          failingPRs.push({
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
          });
        }
      } catch (err) {
        logger.warn(
          { err, prNumber: pr.number },
          "pr-hygiene-gate: failed to check CI for PR",
        );
      }
    }

    logger.info(
      { githubUsername, totalOpenPRs, failingCount: failingPRs.length },
      "pr-hygiene-gate: CI check complete",
    );

    // ── 3. Decision logic ──────────────────────────────────────────────

    // Case A: Failing CI on any PR → override task to fix them
    if (failingPRs.length > 0) {
      const overrideTaskMarkdown = buildFixFailingPRsTask(failingPRs, totalOpenPRs, maxOpen);
      return {
        checked: true,
        totalOpenPRs,
        failingPRs,
        overrideTaskMarkdown,
        reason: `${failingPRs.length} PR(s) with failing CI — task overridden to fix them`,
      };
    }

    // Case B: 3+ open PRs but all passing → override task to get PRs merged
    if (totalOpenPRs >= maxOpen) {
      const overrideTaskMarkdown = buildReducePRCountTask(agentPRs, totalOpenPRs, maxOpen);
      return {
        checked: true,
        totalOpenPRs,
        failingPRs: [],
        overrideTaskMarkdown,
        reason: `${totalOpenPRs} open PRs (max ${maxOpen}) — task overridden to reduce PR count`,
      };
    }

    // Case C: Under budget and no failures → proceed normally
    return {
      checked: true,
      totalOpenPRs,
      failingPRs: [],
      overrideTaskMarkdown: null,
      reason: `${totalOpenPRs} open PRs, 0 failing — gate passed`,
    };
  } catch (err) {
    return failOpen(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Task markdown builders
// ---------------------------------------------------------------------------

function buildFixFailingPRsTask(
  failingPRs: PrHygieneResult["failingPRs"],
  totalOpen: number,
  maxOpen: number,
): string {
  const prList = failingPRs
    .map((pr) => `- PR #${pr.number}: ${pr.title} (${pr.url})`)
    .join("\n");

  return [
    "## ⛔ PR HYGIENE GATE — MANDATORY FIX BEFORE NEW WORK",
    "",
    "**This is an automated override.** Your normal ticket has been held because",
    "you have open PRs with **failing CI checks**. Per the Commit Budget rule",
    "(shared-knowledge/AGENT_ACCOUNTABILITY.md), you MUST fix failing PRs before",
    "starting any new work.",
    "",
    "### Failing PRs (fix these NOW):",
    prList,
    "",
    "### Instructions:",
    "1. For each failing PR above, check out its branch and run the CI checks locally.",
    "2. Fix the failures — tests, lint, type errors, whatever is broken.",
    "3. Push the fix commits to the PR branch.",
    "4. Once CI is green on all PRs, your next heartbeat will resume normal work.",
    "",
    `### PR Budget Status: ${totalOpen}/${maxOpen} open PRs`,
    "",
    "**Do NOT open new PRs or start new tickets.** Fix what is broken first.",
    "Quality over throughput — 1 well-tested PR is worth more than 5 untested ones.",
  ].join("\n");
}

function buildReducePRCountTask(
  agentPRs: Array<{ number: number; title: string; html_url: string }>,
  totalOpen: number,
  maxOpen: number,
): string {
  const prList = agentPRs
    .map((pr) => `- PR #${pr.number}: ${pr.title} (${pr.html_url})`)
    .join("\n");

  return [
    "## ⚠️ PR BUDGET EXCEEDED — REDUCE OPEN PR COUNT",
    "",
    `**This is an automated override.** You have ${totalOpen} open PRs but the`,
    `maximum allowed is ${maxOpen}. Per the Commit Budget rule`,
    "(shared-knowledge/AGENT_ACCOUNTABILITY.md), you may not start new work until",
    "your open PR count drops below the limit.",
    "",
    "### Your open PRs:",
    prList,
    "",
    "### Instructions:",
    "1. Review each open PR — can any be closed as superseded or abandoned?",
    "2. For PRs awaiting review, add a comment requesting review.",
    "3. For PRs with merge conflicts, rebase them.",
    "4. For PRs that are ready, ensure CI is green and request merge.",
    "5. Your next heartbeat will resume normal work once count < " + maxOpen + ".",
    "",
    "**Do NOT open new PRs or start new tickets.** Get existing work merged first.",
  ].join("\n");
}
