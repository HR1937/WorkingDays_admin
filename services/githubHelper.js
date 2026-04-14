const axios = require('axios');

const gh = axios.create({
  baseURL: 'https://api.github.com',
  headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
});

const parseRepo = (input) => {
  const match = input.match(/github\.com\/([^/]+\/[^/]+)/);
  if (match) return match[1].replace(/\.git$/, '');
  return input.replace(/\.git$/, '').replace(/^\//, '');
};

const getRepoTree = async (repoInput) => {
  const repo = parseRepo(repoInput);
  const { data: repoData } = await gh.get(`/repos/${repo}`);
  const branch = repoData.default_branch;
  const { data } = await gh.get(`/repos/${repo}/git/trees/${branch}?recursive=1`);
  const files = data.tree
    .filter(f => f.type === 'blob')
    .filter(f => !f.path.match(/\.(png|jpg|jpeg|gif|svg|ico|woff|ttf|eot|pdf|zip|lock)$/i))
    .map(f => ({ path: f.path, sha: f.sha, size: f.size }));
  return { repo, branch, files };
};

module.exports = { getRepoTree, parseRepo };
