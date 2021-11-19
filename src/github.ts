import * as core from '@actions/core'
import * as github from '@actions/github'
import {getCloudRunEnvironmentVariables} from './gcloud'
import {ContainerConfiguration} from './ContainerConfiguration'

const prDeployCommentMarker = '<!-- cloudrun-action-marker -->\n\n'
export async function addPullRequestComment(comment: string): Promise<number> {
  const githubToken = core.getInput('github_token')

  if (githubToken) {
    const octokit = github.getOctokit(githubToken, {
      userAgent: 'rvdh/cloudrun-action'
    })

    if (github.context.payload.pull_request) {
      // find if we previously commented in this PR before
      const prCommentId = await getCloudRunDeployComment()
      if (prCommentId > 0) {
        return await updatePullRequestComment(prCommentId, comment)
      } else {
        const {data: issueComment} = await octokit.issues.createComment({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          issue_number: github.context.issue.number,
          body: prDeployCommentMarker + comment
        })
        return issueComment.id
      }
    }
  }
  return -1
}

async function getCloudRunDeployComment(): Promise<number> {
  const githubToken = core.getInput('github_token')

  if (githubToken) {
    const octokit = github.getOctokit(githubToken, {
      userAgent: 'rvdh/cloudrun-action'
    })

    if (github.context.payload.pull_request) {
      // find if we previously commented in this PR before

      const {data: issueComments} = await octokit.issues.listComments({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: github.context.issue.number
      })

      for (const comment of issueComments) {
        if (comment.body.includes(prDeployCommentMarker)) return comment.id
      }
    }
  }
  return -1
}

export async function getUsername(): Promise<string> {
  const githubToken = core.getInput('github_token')

  const octokit = github.getOctokit(githubToken, {
    userAgent: 'rvdh/cloudrun-action'
  })
  const authenticatedUser = await octokit.users.getAuthenticated()
  return authenticatedUser.data.login
}

export async function updatePullRequestComment(
  comment_id: number,
  comment: string
): Promise<number> {
  const githubToken = core.getInput('github_token')

  if (githubToken) {
    const octokit = github.getOctokit(githubToken, {
      userAgent: 'rvdh/cloudrun-action'
    })

    if (github.context.payload.pull_request) {
      const {data: issueComment} = await octokit.issues.updateComment({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        comment_id,
        body: prDeployCommentMarker + comment
      })

      return issueComment.id
    }
  }
  return -1
}

export async function getContainerConfiguration(
  supportedContainerConfiguration: ContainerConfiguration
): Promise<ContainerConfiguration> {
  const containerConfig = new ContainerConfiguration()

  // get environment variables from workflow file
  containerConfig.envVars = getCloudRunEnvironmentVariables()

  // get labels from pull request
  const githubToken = core.getInput('github_token')
  const trigger_label = core.getInput('trigger_label')

  if (githubToken) {
    const octokit = github.getOctokit(githubToken, {
      userAgent: 'rvdh/cloudrun-action'
    })

    const {data: issueLabels} = await octokit.issues.listLabelsOnIssue({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: github.context.issue.number
    })

    const supportedEnvVarNames = []
    for (const envVar of supportedContainerConfiguration.envVars) {
      supportedEnvVarNames.push(envVar.name)
    }

    for (const key of issueLabels) {
      core.debug(`issue label: ${key.name}`)
      if (key.name === trigger_label) continue
      if (key.name === 'PORT') {
        core.info(
          'Ignoring PORT environment variable setting, it is not allowed'
        )
        continue
      }
      if (key.name === 'IMAGE_ARGUMENT') {
        containerConfig.arguments.push(key.description)
      }
      if (supportedEnvVarNames.includes(key.name)) {
        let found = false
        for (const currentKey of containerConfig.envVars) {
          if (currentKey.name === key.name) {
            currentKey.value = key.description
            found = true
          }
        }
        if (!found)
          containerConfig.envVars.push({
            name: key.name,
            value: key.description
          })
      } else {
        core.debug(`${key.name} not in ${supportedEnvVarNames}`)
      }
    }
  }

  return containerConfig
}
