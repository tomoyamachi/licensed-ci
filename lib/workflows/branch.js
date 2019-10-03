const core = require('@actions/core');
const exec = require('@actions/exec');
const github = require('@actions/github');
const utils = require('../utils');

PULL_REQUEST_TEMPLATE = `
This PR was auto generated by the 'licensed-ci' GitHub Action.
It contains updates to cached 'github/licensed' dependency metadata to be merged into <base>.

Please review the changed files and adjust as needed before merging.

<prComment>
`.trim();

async function ensureLicensesPullRequest(octokit, head, base) {
  const { data } = await octokit.search.issuesAndPullRequests({
    q: `is:pr is:open repo:${process.env.GITHUB_REPOSITORY} head:${head} base:${base}`
  });

  if (data.total_count > 0) {
    // an open PR from the licenses branch to the parent branch exists
    return;
  }

  const prComment = core.getInput('pr_comment');
  const body = PULL_REQUEST_TEMPLATE.replace('<prComment>', prComment);
  const actor = process.env.GITHUB_ACTOR;

  const { data: pull } = await octokit.pulls.create({
    ...github.context.repo,
    title: `License updates for ${base}`,
    head,
    base,
    body
  });

  await octokit.pulls.createReviewRequest({
    ...github.context.repo,
    pull_number: pull.number,
    reviewers: [actor]
  })

  console.log(`Created pull request for changes: ${pull.html_url}`);
}

function getLicensesBranch(branch) {
  if (branch.endsWith('-licenses')) {
    return branch;
  }

  return `${branch}-licenses`;
}

async function cache() {
  const branch = utils.getBranch();
  const licensesBranch = getLicensesBranch(branch);

  if (branch !== licensesBranch) {
    const { command, configFilePath } = await utils.getLicensedInput();

    // change to a `<branch>/licenses` branch to continue updates
    await utils.ensureBranch(licensesBranch, branch);

    // cache any metadata updates
    await exec.exec(command, ['cache', '-c', configFilePath]);

    // stage any changes, checking only configured cache paths if possible
    const cachePaths = await utils.getCachePaths(command, configFilePath);
    await exec.exec('git', ['add', '--', ...cachePaths]);

    // check for any changes, checking only configured cache paths if possible
    const exitCode = await exec.exec('git', ['diff-index', '--quiet', 'HEAD', '--', ...cachePaths], { ignoreReturnCode: true });
    if (exitCode > 0) {
      // if files were changed, push them back up to origin using the passed in github token
      const commitMessage = core.getInput('commit_message', { required: true });
      const token = core.getInput('github_token', { required: true });
      const octokit = new github.GitHub(token);

      await exec.exec('git', ['remote', 'add', 'licensed-ci-origin', `https://x-access-token:${token}@github.com/${process.env.GITHUB_REPOSITORY}.git`]);
      await exec.exec('git', ['commit', '-m', commitMessage]);
      await exec.exec('git', ['push', 'licensed-ci-origin', licensesBranch]);

      await ensureLicensesPullRequest(octokit, licensesBranch, branch);
    }

    await exec.exec('git', ['checkout', branch])
  }
}

async function status() {
  const { command, configFilePath } = await utils.getLicensedInput();
  const branch = utils.getBranch();
  const licensesBranch = getLicensesBranch(branch);

  console.log('');
  console.log(`Checking status on ${branch}`);
  let exitCode = await exec.exec(command, ['status', '-c', configFilePath], { ignoreReturnCode: true });
  if (exitCode == 0) {
    return;
  }

  if (branch !== licensesBranch) {
    console.log('');
    core.error(`Status check failed on ${branch}.  Checking status on ${licensesBranch}`);
    await exec.exec('git', ['checkout', licensesBranch]);
    exitCode = await exec.exec(command, ['status', '-c', configFilePath], { ignoreReturnCode: true });
    if (exitCode == 0) {
      core.warning(`Status check succeeded on ${licensesBranch}.  Please merge license updates from ${licensesBranch}`);
    } else {
      core.warning(`Status check failed on ${licensesBranch}.  Please review and update ${licensesBranch} as needed`);
    }
  }

  throw new Error(`${command} status failed`);
}

module.exports = {
  cache,
  status,
};