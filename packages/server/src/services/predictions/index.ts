import { Request } from 'express'
import { StatusCodes } from 'http-status-codes'
import { utilBuildChatflow } from '../../utils/buildChatflow'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import pLimit from 'p-limit'

const concurrencyLimit = pLimit(Number.parseInt(process.env.PREDICTION_CONCURRENCY_LIMIT_PER_PROCESS || '0') || 100)

const buildChatflow = async (req: Request) => {
    try {
        // const dbResponse = await utilBuildChatflow(req)
        const dbResponse = await concurrencyLimit(() => utilBuildChatflow(req))
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: predictionsServices.buildChatflow - ${getErrorMessage(error)}`
        )
    }
}

export default {
    buildChatflow
}
