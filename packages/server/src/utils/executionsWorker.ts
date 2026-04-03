import { IExecution } from '../Interface'
import { Compression, Execution } from '../database/entities/Execution'
import { ICommonObject } from 'flowise-components'
import { getDataSource } from '../DataSource'
import logger from './logger'

export interface ExecutionUpdateParams {
    executionId: string
    workspaceId: string
    data?: Partial<IExecution>
}
export default async ({ executionId, workspaceId, data }: ExecutionUpdateParams) => {
    if (process.env.DISABLE_EXECUTION_RECORDING) {
        return
    }
    let appDataSource = getDataSource()
    if (!appDataSource.isInitialized) {
        await appDataSource.initialize()
    }

    let execution
    try {
        execution = await appDataSource.getRepository(Execution).findOneBy({
            id: executionId,
            workspaceId
        })
    } catch (e) {
        logger.error(`getRepository findOneBy ${e}`)
        throw e
    }

    if (!execution) {
        throw new Error(`Execution ${executionId} not found`)
    }

    const updateExecution = new Execution()
    const bodyExecution: ICommonObject = {}
    if (data && data.executionData) {
        bodyExecution.executionDataBlob = await Compression.compress(data.executionData)
        bodyExecution.executionData = '[]'
    }
    if (data && data.state) {
        bodyExecution.state = data.state

        if (data.state === 'STOPPED') {
            bodyExecution.stoppedDate = new Date()
        }
    }

    Object.assign(updateExecution, bodyExecution)

    appDataSource.getRepository(Execution).merge(execution, updateExecution)
    await appDataSource.getRepository(Execution).save(execution)
}
