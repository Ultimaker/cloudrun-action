import * as core from '@actions/core'
import {RequestError} from 'got/dist/source'
import {ContainerConfiguration} from './ContainerConfiguration'

const stringify = require('json-stringify-safe')

export async function getEnvVarsFromImage(
  name: string
): Promise<ContainerConfiguration> {
  const registry_access_token: string = core.getInput('registry_access_token')
  const containerConfig = new ContainerConfiguration()

  const imageUrl = new URL(`https://${name}`)
  const auth = {
    username: 'oauth2accesstoken',
    password: registry_access_token,
    auth: '',
    email: '',
    serveraddress: imageUrl.host
  }
  const authData = Buffer.from(JSON.stringify(auth)).toString('base64')

  const got = require('got')

  try {
    core.debug(`Sending pull image command for ${name}`)
    let response = await got.post(
      `unix:/var/run/docker.sock:/images/create?fromImage=${name}`,
      {
        headers: {'X-Registry-Auth': authData},
        responseType: 'text',
        resolveBodyOnly: true
      }
    )

    core.debug(`pull image response: ${stringify(response, null, 4)}`)

    // inspect the image
    response = await got(
      `unix:/var/run/docker.sock:/images/${name}/json`
    ).json()
    core.debug(`inspect image response: ${stringify(response, null, 4)}`)

    for (const envVar of response.Config.Env) {
      containerConfig.envVars.push({
        name: envVar.split('=')[0],
        value: envVar.split('=')[1]
      })
    }
    if ('IMAGE_ARGUMENTS' in response.Config.Labels) {
      containerConfig.arguments = response.Config.Labels[
        'IMAGE_ARGUMENTS'
      ].split(',')
    }
    return containerConfig
  } catch (error) {
    core.debug(stringify(error, null, 4))
    if (error instanceof RequestError) {
      if (error.request) core.debug(stringify(error.request, null, 4))
      if (error.response) core.debug(stringify(error.response, null, 4))
      core.setFailed(error)
    }
  }
  return containerConfig
}
