const { Octokit } = require("@octokit/rest");
const logger = require("../utils/logger");

// Create GitHub client with personal access token
const createGitHubClient = (token) => {
  return new Octokit({
    auth: token,
    userAgent: "AgenticWorkflow/1.0",
    throttle: {
      onRateLimit: (retryAfter, options) => {
        logger.warn(
          `Rate limit hit, retrying after ${retryAfter}s: ${options.method} ${options.url}`,
        );
        return true; // retry
      },
      onAbuseLimit: (retryAfter, options) => {
        logger.error(`Abuse limit hit: ${options.method} ${options.url}`);
        return false; // don't retry
      },
    },
  });
};

// Validate and parse GitHub repo URL
const parseRepoUrl = (repoUrl) => {
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== "github.com") {
      throw new Error("Only GitHub.com repositories are supported");
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error("Invalid repository URL format");
    }

    return {
      owner: parts[0],
      repo: parts[1],
      full: `${parts[0]}/${parts[1]}`,
    };
  } catch (error) {
    logger.error("Failed to parse GitHub URL:", repoUrl, error.message);
    throw new Error("Invalid GitHub repository URL");
  }
};

// Get default branch name for a repository
const getDefaultBranch = async (github, owner, repo) => {
  try {
    const { data } = await github.repos.get({ owner, repo });
    return data.default_branch || "main";
  } catch (error) {
    logger.error("Failed to get default branch:", error.message);
    return "main"; // fallback
  }
};

// Create a new branch from default branch
const createBranch = async (github, owner, repo, branchName, baseSha) => {
  try {
    await github.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });
    return { success: true, branchName };
  } catch (error) {
    // Handle "reference already exists" gracefully
    if (
      error.status === 422 &&
      error.message?.includes("Reference already exists")
    ) {
      return { success: true, branchName, message: "Branch already exists" };
    }
    logger.error("Failed to create branch:", error.message);
    return { success: false, error: error.message };
  }
};

// Check if user is a collaborator on the repo
const isCollaborator = async (github, owner, repo, username) => {
  try {
    const { data } = await github.repos.checkCollaborator({
      owner,
      repo,
      username,
    });
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    logger.warn("Collaborator check failed:", error.message);
    return false; // fail open for UX
  }
};

// Generate branch name from Jira issue
const generateBranchName = (issueKey, timestamp = null) => {
  const cleanKey = issueKey.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const suffix = timestamp ? `-${timestamp}` : "";
  return `feature/${cleanKey}${suffix}`;
};

// Get commit SHA for a branch
const getBranchSha = async (github, owner, repo, branch) => {
  try {
    const { data } = await github.repos.getBranch({ owner, repo, branch });
    return data.commit.sha;
  } catch (error) {
    logger.error("Failed to get branch SHA:", error.message);
    throw error;
  }
};

module.exports = {
  createGitHubClient,
  parseRepoUrl,
  getDefaultBranch,
  createBranch,
  isCollaborator,
  generateBranchName,
  getBranchSha,
};
