import * as core from '@actions/core'
import * as gcloud from './gcloud'
import * as github from './github'
import * as docker from './docker'

async function create(): Promise<void> {
  const name: string = core.getInput('name', {required: true})
  const serviceAccountKey: string = core.getInput('service_account_key', {
    required: true
  })
  const runRegion: string = core.getInput('run_region', {required: true})
  const image: string = core.getInput('image', {required: true})
  const serviceAccountName: string = core.getInput('service_account_name', {
    required: true
  })
  const vpcConnectorName: string = core.getInput('vpc_connector_name')

  core.info(`Deploying docker image ${image}...`)

  // add github comment
  let comment = `### :construction: Cloud Run Deployment in progress :construction:\n`
  const comment_id = await github.addPullRequestComment(comment)

  // update comment (checking for image)
  comment += `<details><summary>Docker image</summary>Image: ${image}</details>\n\n`
  comment += `- [ ] Waiting for the docker image to be available on Google Container Registry.\n`
  // wait for image
  await github.updatePullRequestComment(comment_id, comment)

  if (!(await gcloud.waitForDockerImage(image, serviceAccountKey))) {
    comment += `\n:exclamation: Timed out waiting for docker image, cannot continue with deployment.\n`
    await github.updatePullRequestComment(comment_id, comment)
    core.setFailed('Docker image not found, stopping.')
    return
  }
  comment = comment.replace('- [ ]', '- [x]')
  comment += `- [ ] Pulling and inspecting image to determine configurable environment variables.\n`
  await github.updatePullRequestComment(comment_id, comment)

  const dockerContainerConfig = await docker.getEnvVarsFromImage(image)
  comment = comment.replace('- [ ]', '- [x]')

  if (dockerContainerConfig.envVars.length > 0) {
    comment += `<details><summary>Configurable environment variables</summary>\n<ul>\n`

    comment += `\nKEY | VALUE\n--- | ---\n`
    for (const envVar of dockerContainerConfig.envVars) {
      comment += `${envVar.name} | ${envVar.value}\n`
    }

    comment += `\nConfigure environment variables by adding labels to the pull request, the name of the label is the environment variable name, the 'description' field should be set to the value.\n</details>\n\n`
  }

  if (dockerContainerConfig.arguments.length) {
    comment += `<details><summary>Container command arguments</summary>\n<ul>\n`
    comment += `This image supports setting an image argument. To configure it, add a label to this PR called 'IMAGE_ARGUMENT'. The description should be a value from the following list:\n`
    comment += `\n| IMAGE_ARGUMENT |\n|---|\n`
    for (let i = 0; i < dockerContainerConfig.arguments.length; i++) {
      for (const argument of dockerContainerConfig.arguments) {
        comment += `| ${argument} |\n`
      }
    }
    comment += `\n</details>\n\n`
  }

  await github.updatePullRequestComment(comment_id, comment)

  const containerConfig = await github.getContainerConfiguration(
    dockerContainerConfig
  )

  if (containerConfig.envVars.length > 0) {
    comment += `<details><summary>Configured environment variables / settings</summary>\n<ul>\n`

    comment += `\nKEY | VALUE\n--- | ---\n`
    for (const key of containerConfig.envVars) {
      comment += `${key.name} | ${key.value}\n`
    }
    comment += `\n</details>\n\n`
  }
  comment += '- [ ] Starting Cloud Run Service\n'
  await github.updatePullRequestComment(comment_id, comment)

  try {
    const serviceConfig = new gcloud.ServiceConfiguration(
      name,
      runRegion,
      serviceAccountKey,
      image,
      serviceAccountName,
      vpcConnectorName,
      containerConfig
    )
    const {url, logsUrl, deploymentDate} = await serviceConfig.createOrUpdate()

    comment += `- Deployment date: ${deploymentDate}.\n`
    comment += `- URL: ${url}\n`
    comment += `- Logs: ${logsUrl}\n`
    comment = comment.replace('- [ ]', '- [x]')
    comment = comment.replace(
      '### :construction: Cloud Run Deployment in progress :construction:',
      '### :white_check_mark: Cloud Run Deployment successful :white_check_mark:'
    )

    await github.updatePullRequestComment(comment_id, comment)
  } catch (error) {
    comment += `- Deployment failed: ${error}.\n`
    comment = comment.replace(
      '### :construction: Cloud Run Deployment in progress :construction:',
      '### :heavy_exclamation_mark: Cloud Run Deployment failed :heavy_exclamation_mark:'
    )
    await github.updatePullRequestComment(comment_id, comment)
    throw error
  }
}

async function destroy(): Promise<void> {
  try {
    const name: string = core.getInput('name', {required: true})
    const serviceAccountKey: string = core.getInput('service_account_key', {
      required: true
    })
    const runRegion: string = core.getInput('run_region', {required: true})
    core.info(`Deleting Cloud Run deployment ${name}...`)

    // add github comment
    let comment = `🤖  Cloud Run Deployment: Deleting\n`
    const comment_id = await github.addPullRequestComment(comment)
    try {
      const serviceConfig = new gcloud.ServiceConfiguration(
        name,
        runRegion,
        serviceAccountKey
      )

      await serviceConfig.delete()
      comment += `🤖  Cloud Run Deployment: Deployment succesfully deleted.\n`
      github.updatePullRequestComment(comment_id, comment)
    } catch (error) {
      comment += `🤖  Cloud Run Deployment: Deployment deletion failed: ${error}.\n`
      github.updatePullRequestComment(comment_id, comment)
      throw error
    }
  } catch (error) {
    core.setFailed(JSON.stringify(error, null, 4))
  }
}

async function main(): Promise<void> {
  try {
    if (core.getInput('delete_service') === 'false') {
      await create()
    } else {
      await destroy()
    }
  } catch (error) {
    core.setFailed(JSON.stringify(error, null, 4))
  }
}

main()
