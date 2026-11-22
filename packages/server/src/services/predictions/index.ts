import { Request } from 'express'
import { StatusCodes } from 'http-status-codes'
import { PreloadedChatflow, utilBuildChatflow } from '../../utils/buildChatflow'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import pLimit from 'p-limit'

const concurrencyLimit = pLimit(Number.parseInt(process.env.PREDICTION_CONCURRENCY_LIMIT_PER_PROCESS || '0') || 100)

const buildChatflow = async (req: Request, preloaded?: PreloadedChatflow) => {
    try {
        const dbResponse = await concurrencyLimit(() => utilBuildChatflow(req, false, preloaded))
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
