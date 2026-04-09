const {
  createGitHubClient,
  parseRepoUrl,
  getDefaultBranch,
  createBranch,
  generateBranchName,
  getBranchSha,
} = require("../../config/github");
const logger = require("../../utils/logger");

// Create GitHub branch for assignee
const createGitHubBranch = async ({
  repoUrl,
  issueKey,
  assigneeGithubUsername,
}) => {
  try {
    if (!process.env.GITHUB_TOKEN) {
      return "✗ failed to create branch: GitHub token not configured";
    }

    const github = createGitHubClient(process.env.GITHUB_TOKEN);
    const { owner, repo } = parseRepoUrl(repoUrl);

    // Get default branch SHA
    const defaultBranch = await getDefaultBranch(github, owner, repo);
    const baseSha = await getBranchSha(github, owner, repo, defaultBranch);

    // Generate branch name
    const branchName = generateBranchName(issueKey);

    // Create the branch
    const result = await createBranch(github, owner, repo, branchName, baseSha);

    if (result.success) {
      return `✓ branch created: ${branchName} for assignee @${assigneeGithubUsername}`;
    } else {
      return `✗ failed to create branch: ${result.error}`;
    }
  } catch (error) {
    logger.error("Branch creation failed:", error);
    return `✗ failed to create branch: ${error.message}`;
  }
};

module.exports = { createGitHubBranch };
