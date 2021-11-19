export class ContainerConfiguration {
  envVars: {
    name: string
    value: string
  }[]

  arguments: string[]

  constructor() {
    this.envVars = []
    this.arguments = []
  }
}
