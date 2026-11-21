import { INodeParams, INodeCredential } from '../src/Interface'

class OpenAIApi implements INodeCredential {
    label: string
    name: string
    version: number
    inputs: INodeParams[]

    constructor() {
        this.label = 'OpenAI API'
        this.name = 'openAIApi'
        this.version = 1.1
        this.inputs = [
            {
                label: 'OpenAI Api Key',
                name: 'openAIApiKey',
                type: 'password'
            },
            {
                label: 'Base URL',
                name: 'openAIBaseUrl',
                type: 'string',
                optional: true,
                placeholder: 'https://api.openai.com/v1',
                description:
                    'Endpoint of an OpenAI compatible deployment. Used by the ChatOpenAI and ChatOpenAI Custom nodes unless the node sets its own BasePath'
            }
        ]
    }
}

module.exports = { credClass: OpenAIApi }
