import { ICommonObject } from 'flowise-components'
import { ExecutionState, IAgentflowExecutedData } from '../../Interface'
import { getErrorMessage } from '../../errors/utils'
import { _removeCredentialId } from '..'
import { SlimAction, toSlimAction } from './trustedState'

export interface ExternalExecutedRecord {
    nodeId: string
    nodeLabel: string
    status?: ExecutionState
    previousNodeIds: string[]
    data: { name?: string; state?: ICommonObject; error?: string; output?: { humanInputAction: SlimAction } }
}

const isPlainObject = (value: unknown): value is ICommonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function toExternalRecord(record: IAgentflowExecutedData): ExternalExecutedRecord {
    const source: ICommonObject = isPlainObject(record.data) ? record.data : {}
    const data: ExternalExecutedRecord['data'] = { name: source.name }
    if (source.state !== undefined) data.state = source.state
    if (source.error !== undefined && source.error !== null) {
        data.error = typeof source.error === 'string' ? source.error : getErrorMessage(source.error)
    }
    const action = record.status === 'STOPPED' ? source.output?.humanInputAction : undefined
    if (isPlainObject(action)) data.output = { humanInputAction: toSlimAction(action) }
    return {
        nodeId: record.nodeId,
        nodeLabel: record.nodeLabel,
        status: record.status,
        previousNodeIds: record.previousNodeIds ?? [],
        data
    }
}

// TS18: only the internal Flowise chat shows executions from the records; other clients read the state and the action
export function toClientExecutedData(
    records: IAgentflowExecutedData[],
    isInternal: boolean
): IAgentflowExecutedData[] | ExternalExecutedRecord[] {
    return isInternal ? records.map((record) => _removeCredentialId(record)) : records.map(toExternalRecord)
}
