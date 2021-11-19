import * as os from 'os'
import * as core from '@actions/core'
import * as fs from 'fs'
import {ContainerConfiguration} from './ContainerConfiguration'
import {GaxiosError} from 'googleapis-common'

export class ServiceConfiguration {
  name: string
  runRegion: string
  serviceAccountKey: string

  image?: string
  serviceAccountName?: string
  vpcConnectorName?: string
  containerConfig?: ContainerConfiguration

  project = ''

  constructor(
    name: string,
    runRegion: string,
    serviceAccountKey: string,
    image?: string,
    serviceAccountName?: string,
    vpcConnectorName?: string,
    containerConfig?: ContainerConfiguration
  ) {
    this.name = name
    this.runRegion = runRegion
    this.serviceAccountKey = serviceAccountKey

    if (image) this.image = image
    if (serviceAccountName) this.serviceAccountName = serviceAccountName
    if (vpcConnectorName) this.vpcConnectorName = vpcConnectorName
    if (containerConfig) this.containerConfig = containerConfig
  }

  serviceName(): string {
    return this.name.replace(/_/g, '-')
  }

  async createOrUpdate(): Promise<{
    url: string
    logsUrl: string
    deploymentDate: Date
  }> {
    try {
      const {google} = require('googleapis')
      const run = google.run('v1')

      await setGoogleApplicationCredentials(this.serviceAccountKey)

      // Obtain user credentials to use for the request
      const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
      })

      const authClient = await auth.getClient()
      google.options({auth: authClient})
      this.project = await auth.getProjectId()

      const serviceName = this.serviceName()

      core.debug(
        `Checking if service ${serviceName} exists (name: namespaces/${this.project}/services/${serviceName})..`
      )
      try {
        await run.namespaces.services.get(
          {
            name: `namespaces/${this.project}/services/${serviceName}`
          },
          {
            rootUrl: `https://${this.runRegion}-run.googleapis.com`
          }
        )
        core.debug(`Updating service ${serviceName}.`)
        const response = await run.namespaces.services.replaceService(
          {
            name: `namespaces/${this.project}/services/${serviceName}`,
            requestBody: this.cloudRunCreateService()
          },
          {
            rootUrl: `https://${this.runRegion}-run.googleapis.com`
          }
        )
        core.debug(JSON.stringify(response, null, 4))

        core.debug(`Service ${serviceName} updated`)
      } catch (error) {
        core.debug(JSON.stringify(error, null, 4))
        if (error instanceof GaxiosError) {
          if (error.response?.status === 404) {
            core.debug(`Creating service ${serviceName}`)
            try {
              await run.namespaces.services.create(
                {
                  parent: `namespaces/${this.project}`,
                  requestBody: this.cloudRunCreateService()
                },
                {
                  rootUrl: `https://${this.runRegion}-run.googleapis.com`
                }
              )
              core.debug(`Service ${serviceName} created`)
            } catch (crError) {
              if (crError instanceof GaxiosError) {
                core.debug(JSON.stringify(crError.response, null, 4))
              } else {
                core.debug(JSON.stringify(crError, null, 4))
              }
            }
          }
        }
      }

      await this.setCloudRunServiceIAMPolicy()
      const {url, deploymentDate} = await this.getStatus()
      return {
        url,
        logsUrl: `https://console.cloud.google.com/logs/viewer?advancedFilter=resource.type%20%3D%20%22cloud_run_revision%22%0Aresource.labels.service_name%20%3D%20%22${serviceName}%22%0Aresource.labels.location%20%3D%20%22${this.runRegion}%22%0A%20severity%3E%3DDEFAULT&project=${this.project}`,
        deploymentDate
      }
    } catch (error) {
      core.setFailed(JSON.stringify(error, null, 4))
      throw error
    }
  }

  cloudRunCreateService(): {} {
    core.debug(JSON.stringify(this.containerConfig, null, 4))

    return {
      apiVersion: 'serving.knative.dev/v1',
      kind: 'Service',
      metadata: {
        name: this.serviceName(),
        namespace: this.project
      },
      spec: {
        template: {
          metadata: {
            annotations: {
              'run.googleapis.com/vpc-access-connector': this.vpcConnectorName
            }
          },
          spec: {
            serviceAccountName: this.serviceAccountName,
            containers: [
              {
                image: this.image,
                env: this.containerConfig?.envVars,
                args: this.containerConfig?.arguments
              }
            ]
          }
        }
      }
    }
  }

  async setCloudRunServiceIAMPolicy(): Promise<void> {
    const {google} = require('googleapis')
    const run = google.run('v1')

    // Set IAM policy to allow unauthenticated access
    if (core.getInput('allow_unauthenticated')) {
      await run.projects.locations.services.setIamPolicy({
        resource: `projects/${this.project}/locations/${
          this.runRegion
        }/services/${this.serviceName()}`,
        requestBody: {
          policy: {
            bindings: [
              {
                members: ['allUsers'],
                role: 'roles/run.invoker'
              }
            ]
          }
        }
      })
    }
  }

  async delete(): Promise<void> {
    try {
      const {google} = require('googleapis')
      const run = google.run('v1')
      const serviceName = this.serviceName()
      await setGoogleApplicationCredentials(this.serviceAccountKey)
      // Obtain user credentials to use for the request
      const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
      })

      const authClient = await auth.getClient()
      google.options({auth: authClient})
      const project = await auth.getProjectId()

      core.debug(
        `Checking if service ${serviceName} exists (name: namespaces/${project}/services/${serviceName})..`
      )
      try {
        await run.namespaces.services.delete(
          {
            name: `namespaces/${project}/services/${serviceName}`
          },
          {
            rootUrl: `https://${this.runRegion}-run.googleapis.com`
          }
        )
        core.info(`Service ${serviceName} deleted`)
      } catch (error) {
        if (error instanceof GaxiosError) {
          if (error.response?.status === 404) {
            core.info(`Service ${serviceName} does not exist, unable to delete`)
            return
          }
        }
        throw error
      }
    } catch (error) {
      core.setFailed(JSON.stringify(error, null, 4))
      throw error
    }
  }

  async getStatus(): Promise<{url: string; deploymentDate: Date}> {
    const {google} = require('googleapis')
    const run = google.run('v1')

    // Wait until service is ready
    let attempt = 0
    while (attempt < 100) {
      attempt++
      core.debug(`Waiting for service to become ready, attempt ${attempt}...`)
      await delay(500)
      const res = await run.namespaces.services.get(
        {
          name: `namespaces/${this.project}/services/${this.serviceName()}`
        },
        {
          rootUrl: `https://${this.runRegion}-run.googleapis.com`
        }
      )
      if (res.data.status.conditions[0].status !== 'Unknown') {
        if (res.data.status.url) {
          core.setOutput('url', res.data.status.url)
          return {
            url: res.data.status.url,
            deploymentDate: res.data.status.conditions[0].lastTransitionTime
          }
        } else {
          throw new Error(
            `${
              res.data.status.conditions[0].message
            }\nView logs for this revision: https://console.cloud.google.com/run/detail/${
              this.runRegion
            }/${this.serviceName()}/logs?project=${this.project}`
          )
        }
      }
    }
    throw new Error(
      'Unable to retrieve service URL! Check the Cloud Run deployment for errors.'
    )
  }
}

async function setGoogleApplicationCredentials(
  serviceAccountKey: string
): Promise<void> {
  if (!process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
    const uniqueFilename = require('unique-filename')

    const randomTmpFile = uniqueFilename(os.tmpdir())

    fs.writeFile(
      randomTmpFile,
      serviceAccountKey,
      function (err: Error | null) {
        if (err) {
          core.debug(String(err))
        }
      }
    )

    core.exportVariable('GOOGLE_APPLICATION_CREDENTIALS', randomTmpFile)
  }
}

export function getCloudRunEnvironmentVariables(): {
  name: string
  value: string
}[] {
  const entries = []
  for (const key in process.env) {
    if (key.startsWith('CLOUDRUN_ACTION_')) {
      const value = process.env[key]
      if (value !== undefined) {
        const entry = {
          name: key.replace('CLOUDRUN_ACTION_', ''),
          value
        }
        entries.push(entry)
      }
    }
  }

  const environment: {name: string; value: string}[] = entries

  return environment
}

async function delay(ms: number): Promise<void> {
  core.debug(`Sleeping for ${ms}ms`)
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitForDockerImage(
  image: string,
  serviceAccountKey: string
): Promise<boolean> {
  // Obtain user credentials to use for the request
  await setGoogleApplicationCredentials(serviceAccountKey)

  const {google} = require('googleapis')
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  })

  const authClient = await auth.getClient()
  google.options({auth: authClient})
  const project = await auth.getProjectId()

  const imageUrl = new URL(`https://${image}`)
  const imageName = imageUrl.pathname.substring(
    imageUrl.pathname.lastIndexOf('/') + 1,
    imageUrl.pathname.lastIndexOf(':')
  )
  const imageTag = imageUrl.pathname.substring(
    imageUrl.pathname.lastIndexOf(':') + 1
  )
  const url = `https://${imageUrl.host}/v2/${project}/${imageName}/manifests/${imageTag}`
  let attempt = 0
  const checkInterval = Number.parseInt(core.getInput('image_check_interval'))
  const maxAttempts =
    (Number.parseInt(core.getInput('image_check_timeout')) * 60) / checkInterval

  while (attempt < maxAttempts) {
    attempt++
    core.debug(`Waiting for docker image to appear, attempt ${attempt}...`)
    core.debug(`Requesting ${url}`)

    try {
      await auth.request({
        url,
        method: 'HEAD',
        headers: {Accept: '*/*'}
      })
      return true
    } catch (error) {
      if (error instanceof GaxiosError) {
        if (error.response?.status !== 404) {
          core.debug(`Unexpected error occurred`)
          throw error
        }
      }
    }

    await delay(checkInterval * 1000)
  }
  return false
}
