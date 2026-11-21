import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { listFlows } from '../utils'

const REDIRECT_FLOW_MISUSE_MESSAGE = 'Redirect to Flow must be the only node connected to Start'

class RedirectFlow_Agentflow implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    color: string
    hideOutput: boolean
    baseClasses: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'Redirect to Flow'
        this.name = 'redirectFlowAgentflow'
        this.version = 1.0
        this.type = 'RedirectFlow'
        this.category = 'Agent Flows'
        this.description = 'Run the selected flow directly in place of this one. Must be the only node after Start.'
        this.baseClasses = [this.type]
        this.color = '#5FA8D3'
        this.hideOutput = true
        this.inputs = [
            {
                label: 'Select Flow',
                name: 'redirectFlowSelectedFlow',
                type: 'asyncOptions',
                loadMethod: 'listFlows'
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        async listFlows(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
            return listFlows(options)
        }
    }

    // The server swaps in the selected flow before any node runs, so reaching run() means the flow has other nodes.
    async run(): Promise<any> {
        throw new Error(REDIRECT_FLOW_MISUSE_MESSAGE)
    }
}

module.exports = { nodeClass: RedirectFlow_Agentflow }
