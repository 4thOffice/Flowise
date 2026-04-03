import { DataSource } from 'typeorm'
import { ChatMessage } from '../database/entities/ChatMessage'
import { IChatMessage } from '../Interface'
import { getRunningExpressApp } from '../utils/getRunningExpressApp'
import { v4 as uuidv4 } from 'uuid'

/**
 * Method that add chat messages.
 * @param {Partial<IChatMessage>} chatMessage
 */
export const utilAddChatMessage = async (chatMessage: Partial<IChatMessage>, appDataSource?: DataSource): Promise<ChatMessage> => {
    if (process.env.DISABLE_CHAT_MESSAGE_RECORDING) {
        chatMessage.id = chatMessage.id || uuidv4()
        chatMessage.createdDate = chatMessage.createdDate || new Date()
        return chatMessage as ChatMessage
    }
    const dataSource = appDataSource ?? getRunningExpressApp().AppDataSource
    const newChatMessage = new ChatMessage()
    Object.assign(newChatMessage, chatMessage)
    if (!newChatMessage.createdDate) {
        newChatMessage.createdDate = new Date()
    }
    const chatmessage = await dataSource.getRepository(ChatMessage).create(newChatMessage)
    const dbResponse = await dataSource.getRepository(ChatMessage).save(chatmessage)
    return dbResponse
}
