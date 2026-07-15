import { INodeParams, INodeCredential } from '../src/Interface'

/*
Usecase: Use secret (e.g. API key) inside custom node function without hardcoding it
Usage:
1. Go to baseUrl/credentials
2. Add Credential
3. Select Custom Node Secret
4. Set secret's name and value
5. Create custom function node
6. Select secret
7. Inside function body, $name will have value that you set earlier (similar to how input variables are set)
*/

class CustomNodeSecretCredential implements INodeCredential {
    label: string
    name: string
    version: number
    inputs: INodeParams[]

    constructor() {
        this.label = 'Custom Node Secret'
        this.name = 'customNodeSecret'
        this.version = 1.0
        this.inputs = [
            {
                label: 'Name',
                name: 'name',
                type: 'string'
            },
            {
                label: 'Value',
                name: 'value',
                type: 'password'
            }
        ]
    }
}

module.exports = { credClass: CustomNodeSecretCredential }
