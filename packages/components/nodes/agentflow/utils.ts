import { BaseMessage, MessageContentImageUrl, AIMessageChunk } from '@langchain/core/messages'
import { getImageUploads } from '../../src/multiModalUtils'
import { addSingleFileToStorage, getFileFromStorage } from '../../src/storageUtils'
import { ICommonObject, IDatabaseEntity, IFileUpload, IMessage, INodeData, INodeOptionsValue } from '../../src/Interface'
import { DataSource } from 'typeorm'
import { BaseMessageLike } from '@langchain/core/messages'
import { IFlowState } from './Interface.Agentflow'
import { getCredentialData, getCredentialParam, handleEscapeCharacters, mapMimeTypeToInputField } from '../../src/utils'
import fetch from 'node-fetch'
import { cloneDeep, isEqual } from 'lodash'

export const addImagesToMessages = async (
    options: ICommonObject,
    allowImageUploads: boolean,
    imageResolution?: 'auto' | 'low' | 'high'
): Promise<MessageContentImageUrl[]> => {
    const imageContent: MessageContentImageUrl[] = []

    if (allowImageUploads && options?.uploads && options?.uploads.length > 0) {
        const imageUploads = getImageUploads(options.uploads)
        for (const upload of imageUploads) {
            let bf = upload.data
            if (upload.type == 'stored-file') {
                const fileName = upload.name.replace(/^FILE-STORAGE::/, '')
                const contents = await getFileFromStorage(fileName, options.orgId, options.chatflowid, options.chatId)
                // as the image is stored in the server, read the file and convert it to base64
                bf = 'data:' + upload.mime + ';base64,' + contents.toString('base64')

                imageContent.push({
                    type: 'image_url',
                    image_url: {
                        url: bf,
                        detail: imageResolution ?? 'low'
                    }
                })
            } else if (upload.type == 'url' && bf) {
                imageContent.push({
                    type: 'image_url',
                    image_url: {
                        url: bf,
                        detail: imageResolution ?? 'low'
                    }
                })
            }
        }
    }

    return imageContent
}

/**
 * Process message array to replace stored file references with base64 image data
 * @param messages Array of messages that may contain image references
 * @param options Common options object containing chatflowid and chatId
 * @returns Object containing updated messages array and transformed original messages
 */
export const processMessagesWithImages = async (
    messages: BaseMessageLike[],
    options: ICommonObject
): Promise<{
    updatedMessages: BaseMessageLike[]
    transformedMessages: BaseMessageLike[]
}> => {
    if (!messages || !options.chatflowid || !options.chatId) {
        return {
            updatedMessages: messages,
            transformedMessages: []
        }
    }

    // Create a deep copy of the messages to avoid mutating the original
    const updatedMessages = JSON.parse(JSON.stringify(messages))
    // Track which messages were transformed
    const transformedMessages: BaseMessageLike[] = []

    // Scan through all messages looking for stored-file references
    for (let i = 0; i < updatedMessages.length; i++) {
        const message = updatedMessages[i]

        // Skip non-user messages or messages without content
        if (message.role !== 'user' || !message.content) {
            continue
        }

        // Handle array content (typically containing file references)
        if (Array.isArray(message.content)) {
            const imageContents: MessageContentImageUrl[] = []
            let hasImageReferences = false

            // Process each content item
            for (const item of message.content) {
                // Look for stored-file type items
                if (item.type === 'stored-file' && item.name && item.mime.startsWith('image/')) {
                    hasImageReferences = true
                    try {
                        const fileName = item.name.replace(/^FILE-STORAGE::/, '')
                        // Get file contents from storage
                        const contents = await getFileFromStorage(fileName, options.orgId, options.chatflowid, options.chatId)

                        // Create base64 data URL
                        const base64Data = 'data:' + item.mime + ';base64,' + contents.toString('base64')

                        // Add to image content array
                        imageContents.push({
                            type: 'image_url',
                            image_url: {
                                url: base64Data,
                                detail: item.imageResolution ?? 'low'
                            }
                        })
                    } catch (error) {
                        console.error(`Failed to load image ${item.name}:`, error)
                    }
                }
            }

            // Replace the content with the image content array
            if (imageContents.length > 0) {
                // Store the original message before modifying
                if (hasImageReferences) {
                    transformedMessages.push(JSON.parse(JSON.stringify(messages[i])))
                }
                updatedMessages[i].content = imageContents
            }
        }
    }

    return {
        updatedMessages,
        transformedMessages
    }
}

/**
 * Replace base64 image data in messages with file references
 * @param messages Array of messages that may contain base64 image data
 * @param uniqueImageMessages Array of messages with file references for new images
 * @param pastImageMessages Array of messages with file references for previous images
 * @returns Updated messages array with file references instead of base64 data
 */
export const replaceBase64ImagesWithFileReferences = (
    messages: BaseMessageLike[],
    uniqueImageMessages: BaseMessageLike[] = [],
    pastImageMessages: BaseMessageLike[] = []
): BaseMessageLike[] => {
    // Create a deep copy to avoid mutating the original
    const updatedMessages = JSON.parse(JSON.stringify(messages))

    // Track positions in replacement arrays
    let pastMessageIndex = 0
    let pastContentIndex = 0
    let uniqueMessageIndex = 0
    let uniqueContentIndex = 0

    for (let i = 0; i < updatedMessages.length; i++) {
        const message = updatedMessages[i]
        if (message.content && Array.isArray(message.content)) {
            for (let j = 0; j < message.content.length; j++) {
                const item = message.content[j]
                if (item.type === 'image_url') {
                    // Try past images first
                    let replacement = null

                    if (pastMessageIndex < pastImageMessages.length) {
                        const pastMessage = pastImageMessages[pastMessageIndex] as BaseMessage | undefined
                        if (pastMessage && Array.isArray(pastMessage.content)) {
                            if (pastContentIndex < pastMessage.content.length) {
                                replacement = pastMessage.content[pastContentIndex]
                                pastContentIndex++

                                // Move to next message if we've used all content in current one
                                if (pastContentIndex >= pastMessage.content.length) {
                                    pastMessageIndex++
                                    pastContentIndex = 0
                                }
                            } else {
                                // Current message has no more content, move to next
                                pastMessageIndex++
                                pastContentIndex = 0

                                // Try again with the next message
                                if (pastMessageIndex < pastImageMessages.length) {
                                    const nextPastMessage = pastImageMessages[pastMessageIndex] as BaseMessage | undefined
                                    if (nextPastMessage && Array.isArray(nextPastMessage.content) && nextPastMessage.content.length > 0) {
                                        replacement = nextPastMessage.content[0]
                                        pastContentIndex = 1
                                    }
                                }
                            }
                        }
                    }

                    // Try unique images if no past image replacement found
                    if (!replacement && uniqueMessageIndex < uniqueImageMessages.length) {
                        const uniqueMessage = uniqueImageMessages[uniqueMessageIndex] as BaseMessage | undefined
                        if (uniqueMessage && Array.isArray(uniqueMessage.content)) {
                            if (uniqueContentIndex < uniqueMessage.content.length) {
                                replacement = uniqueMessage.content[uniqueContentIndex]
                                uniqueContentIndex++

                                // Move to next message if we've used all content in current one
                                if (uniqueContentIndex >= uniqueMessage.content.length) {
                                    uniqueMessageIndex++
                                    uniqueContentIndex = 0
                                }
                            } else {
                                // Current message has no more content, move to next
                                uniqueMessageIndex++
                                uniqueContentIndex = 0

                                // Try again with the next message
                                if (uniqueMessageIndex < uniqueImageMessages.length) {
                                    const nextUniqueMessage = uniqueImageMessages[uniqueMessageIndex] as BaseMessage | undefined
                                    if (
                                        nextUniqueMessage &&
                                        Array.isArray(nextUniqueMessage.content) &&
                                        nextUniqueMessage.content.length > 0
                                    ) {
                                        replacement = nextUniqueMessage.content[0]
                                        uniqueContentIndex = 1
                                    }
                                }
                            }
                        }
                    }

                    // Apply replacement if found
                    if (replacement) {
                        message.content[j] = {
                            ...replacement
                        }
                    }
                }
            }
        }
    }

    return updatedMessages
}

/**
 * Get unique image messages from uploads
 * @param options Common options object containing uploads
 * @param messages Array of messages to check for existing images
 * @param modelConfig Model configuration object containing allowImageUploads and imageResolution
 * @returns Object containing imageMessageWithFileRef and imageMessageWithBase64
 */
export const getUniqueImageMessages = async (
    options: ICommonObject,
    messages: BaseMessageLike[],
    modelConfig?: ICommonObject
): Promise<{ imageMessageWithFileRef: BaseMessageLike; imageMessageWithBase64: BaseMessageLike } | undefined> => {
    if (!options.uploads) return undefined

    // Get images from uploads
    const images = await addImagesToMessages(options, modelConfig?.allowImageUploads, modelConfig?.imageResolution)

    // Filter out images that are already in previous messages
    const uniqueImages = images.filter((image) => {
        // Check if this image is already in any existing message
        return !messages.some((msg: any) => {
            // For multimodal content (arrays with image objects)
            if (Array.isArray(msg.content)) {
                return msg.content.some(
                    (item: any) =>
                        // Compare by image URL/content for image objects
                        item.type === 'image_url' && image.type === 'image_url' && JSON.stringify(item) === JSON.stringify(image)
                )
            }
            // For direct comparison of simple content
            return JSON.stringify(msg.content) === JSON.stringify(image)
        })
    })

    if (uniqueImages.length === 0) {
        return undefined
    }

    // Create messages with the original file references for storage/display
    const imageMessageWithFileRef = {
        role: 'user',
        content: options.uploads.map((upload: IFileUpload) => ({
            type: upload.type,
            name: upload.name,
            mime: upload.mime,
            imageResolution: modelConfig?.imageResolution
        }))
    }

    // Create messages with base64 data for the LLM
    const imageMessageWithBase64 = {
        role: 'user',
        content: uniqueImages
    }

    return {
        imageMessageWithFileRef,
        imageMessageWithBase64
    }
}

/**
 * Get past chat history image messages
 * @param pastChatHistory Array of past chat history messages
 * @param options Common options object
 * @returns Object containing updatedPastMessages and transformedPastMessages
 */
export const getPastChatHistoryImageMessages = async (
    pastChatHistory: BaseMessageLike[],
    options: ICommonObject
): Promise<{ updatedPastMessages: BaseMessageLike[]; transformedPastMessages: BaseMessageLike[] }> => {
    const chatHistory = []
    const transformedPastMessages = []

    for (let i = 0; i < pastChatHistory.length; i++) {
        const message = pastChatHistory[i] as BaseMessage & { role: string }
        const messageRole = message.role || 'user'
        if (message.additional_kwargs && message.additional_kwargs.fileUploads) {
            // example: [{"type":"stored-file","name":"0_DiXc4ZklSTo3M8J4.jpg","mime":"image/jpeg"}]
            const fileUploads = message.additional_kwargs.fileUploads
            const artifacts = message.additional_kwargs.artifacts
            const fileAnnotations = message.additional_kwargs.fileAnnotations
            const usedTools = message.additional_kwargs.usedTools
            try {
                let messageWithFileUploads = ''
                const uploads: IFileUpload[] = typeof fileUploads === 'string' ? JSON.parse(fileUploads) : fileUploads
                const imageContents: MessageContentImageUrl[] = []
                for (const upload of uploads) {
                    if (upload.type === 'stored-file' && upload.mime.startsWith('image/')) {
                        const fileName = upload.name.replace(/^FILE-STORAGE::/, '')
                        const fileData = await getFileFromStorage(fileName, options.orgId, options.chatflowid, options.chatId)
                        // as the image is stored in the server, read the file and convert it to base64
                        const bf = 'data:' + upload.mime + ';base64,' + fileData.toString('base64')

                        imageContents.push({
                            type: 'image_url',
                            image_url: {
                                url: bf
                            }
                        })
                    } else if (upload.type === 'url' && upload.mime.startsWith('image') && upload.data) {
                        imageContents.push({
                            type: 'image_url',
                            image_url: {
                                url: upload.data
                            }
                        })
                    } else if (upload.type === 'stored-file:full') {
                        const fileLoaderNodeModule = await import('../../nodes/documentloaders/File/File')
                        // @ts-ignore
                        const fileLoaderNodeInstance = new fileLoaderNodeModule.nodeClass()
                        const nodeOptions = {
                            retrieveAttachmentChatId: true,
                            chatflowid: options.chatflowid,
                            chatId: options.chatId,
                            orgId: options.orgId
                        }
                        let fileInputFieldFromMimeType = 'txtFile'
                        fileInputFieldFromMimeType = mapMimeTypeToInputField(upload.mime)
                        const nodeData = {
                            inputs: {
                                [fileInputFieldFromMimeType]: `FILE-STORAGE::${JSON.stringify([upload.name])}`
                            }
                        }
                        const documents: string = await fileLoaderNodeInstance.init(nodeData, '', nodeOptions)
                        messageWithFileUploads += `<doc name='${upload.name}'>${handleEscapeCharacters(documents, true)}</doc>\n\n`
                    }
                }
                const messageContent = messageWithFileUploads ? `${messageWithFileUploads}\n\n${message.content}` : message.content
                const hasArtifacts = artifacts && Array.isArray(artifacts) && artifacts.length > 0
                const hasFileAnnotations = fileAnnotations && Array.isArray(fileAnnotations) && fileAnnotations.length > 0
                const hasUsedTools = usedTools && Array.isArray(usedTools) && usedTools.length > 0

                if (imageContents.length > 0) {
                    const imageMessage: any = {
                        role: messageRole,
                        content: imageContents
                    }
                    if (hasArtifacts || hasFileAnnotations || hasUsedTools) {
                        imageMessage.additional_kwargs = {}
                        if (hasArtifacts) imageMessage.additional_kwargs.artifacts = artifacts
                        if (hasFileAnnotations) imageMessage.additional_kwargs.fileAnnotations = fileAnnotations
                        if (hasUsedTools) imageMessage.additional_kwargs.usedTools = usedTools
                    }
                    chatHistory.push(imageMessage)
                    transformedPastMessages.push({
                        role: messageRole,
                        content: [...JSON.parse((pastChatHistory[i] as any).additional_kwargs.fileUploads)]
                    })
                }

                const contentMessage: any = {
                    role: messageRole,
                    content: messageContent
                }
                if (hasArtifacts || hasFileAnnotations || hasUsedTools) {
                    contentMessage.additional_kwargs = {}
                    if (hasArtifacts) contentMessage.additional_kwargs.artifacts = artifacts
                    if (hasFileAnnotations) contentMessage.additional_kwargs.fileAnnotations = fileAnnotations
                    if (hasUsedTools) contentMessage.additional_kwargs.usedTools = usedTools
                }
                chatHistory.push(contentMessage)
            } catch (e) {
                // failed to parse fileUploads, continue with text only
                const hasArtifacts = artifacts && Array.isArray(artifacts) && artifacts.length > 0
                const hasFileAnnotations = fileAnnotations && Array.isArray(fileAnnotations) && fileAnnotations.length > 0
                const hasUsedTools = usedTools && Array.isArray(usedTools) && usedTools.length > 0

                const errorMessage: any = {
                    role: messageRole,
                    content: message.content
                }
                if (hasArtifacts || hasFileAnnotations || hasUsedTools) {
                    errorMessage.additional_kwargs = {}
                    if (hasArtifacts) errorMessage.additional_kwargs.artifacts = artifacts
                    if (hasFileAnnotations) errorMessage.additional_kwargs.fileAnnotations = fileAnnotations
                    if (hasUsedTools) errorMessage.additional_kwargs.usedTools = usedTools
                }
                chatHistory.push(errorMessage)
            }
        } else if (message.additional_kwargs) {
            const hasArtifacts =
                message.additional_kwargs.artifacts &&
                Array.isArray(message.additional_kwargs.artifacts) &&
                message.additional_kwargs.artifacts.length > 0
            const hasFileAnnotations =
                message.additional_kwargs.fileAnnotations &&
                Array.isArray(message.additional_kwargs.fileAnnotations) &&
                message.additional_kwargs.fileAnnotations.length > 0
            const hasUsedTools =
                message.additional_kwargs.usedTools &&
                Array.isArray(message.additional_kwargs.usedTools) &&
                message.additional_kwargs.usedTools.length > 0

            if (hasArtifacts || hasFileAnnotations || hasUsedTools) {
                const messageAdditionalKwargs: any = {}
                if (hasArtifacts) messageAdditionalKwargs.artifacts = message.additional_kwargs.artifacts
                if (hasFileAnnotations) messageAdditionalKwargs.fileAnnotations = message.additional_kwargs.fileAnnotations
                if (hasUsedTools) messageAdditionalKwargs.usedTools = message.additional_kwargs.usedTools

                chatHistory.push({
                    role: messageRole,
                    content: message.content,
                    additional_kwargs: messageAdditionalKwargs
                })
            } else {
                chatHistory.push({
                    role: messageRole,
                    content: message.content
                })
            }
        } else {
            chatHistory.push({
                role: messageRole,
                content: message.content
            })
        }
    }
    return {
        updatedPastMessages: chatHistory,
        transformedPastMessages
    }
}

/**
 * Gets MIME type from filename extension
 */
export const getMimeTypeFromFilename = (filename: string): string => {
    const extension = filename.toLowerCase().split('.').pop()
    const mimeTypes: { [key: string]: string } = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        pdf: 'application/pdf',
        txt: 'text/plain',
        csv: 'text/csv',
        json: 'application/json',
        html: 'text/html',
        xml: 'application/xml'
    }
    return mimeTypes[extension || ''] || 'application/octet-stream'
}

/**
 * Gets artifact type from filename extension for UI rendering
 */
export const getArtifactTypeFromFilename = (filename: string): string => {
    const extension = filename.toLowerCase().split('.').pop()
    const artifactTypes: { [key: string]: string } = {
        png: 'png',
        jpg: 'jpeg',
        jpeg: 'jpeg',
        html: 'html',
        htm: 'html',
        md: 'markdown',
        markdown: 'markdown',
        json: 'json',
        js: 'javascript',
        javascript: 'javascript',
        tex: 'latex',
        latex: 'latex',
        txt: 'text',
        csv: 'text',
        pdf: 'text'
    }
    return artifactTypes[extension || ''] || 'text'
}

/**
 * Saves base64 image data to storage and returns file information
 */
export const saveBase64Image = async (
    outputItem: any,
    options: ICommonObject
): Promise<{ filePath: string; fileName: string; totalSize: number } | null> => {
    try {
        if (!outputItem.result) {
            return null
        }

        // Extract base64 data and create buffer
        const base64Data = outputItem.result
        const imageBuffer = Buffer.from(base64Data, 'base64')

        // Determine file extension and MIME type
        const outputFormat = outputItem.output_format || 'png'
        const fileName = `generated_image_${outputItem.id || Date.now()}.${outputFormat}`
        const mimeType = outputFormat === 'png' ? 'image/png' : 'image/jpeg'

        // Save the image using the existing storage utility
        const { path, totalSize } = await addSingleFileToStorage(
            mimeType,
            imageBuffer,
            fileName,
            options.orgId,
            options.chatflowid,
            options.chatId
        )

        return { filePath: path, fileName, totalSize }
    } catch (error) {
        console.error('Error saving base64 image:', error)
        return null
    }
}

/**
 * Saves Gemini inline image data to storage and returns file information
 */
export const saveGeminiInlineImage = async (
    inlineItem: any,
    options: ICommonObject
): Promise<{ filePath: string; fileName: string; totalSize: number } | null> => {
    try {
        if (!inlineItem.data || !inlineItem.mimeType) {
            return null
        }

        // Extract base64 data and create buffer
        const base64Data = inlineItem.data
        const imageBuffer = Buffer.from(base64Data, 'base64')

        // Determine file extension from MIME type
        const mimeType = inlineItem.mimeType
        let extension = 'png'
        if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
            extension = 'jpg'
        } else if (mimeType.includes('png')) {
            extension = 'png'
        } else if (mimeType.includes('gif')) {
            extension = 'gif'
        } else if (mimeType.includes('webp')) {
            extension = 'webp'
        }

        const fileName = `gemini_generated_image_${Date.now()}.${extension}`

        // Save the image using the existing storage utility
        const { path, totalSize } = await addSingleFileToStorage(
            mimeType,
            imageBuffer,
            fileName,
            options.orgId,
            options.chatflowid,
            options.chatId
        )

        return { filePath: path, fileName, totalSize }
    } catch (error) {
        console.error('Error saving Gemini inline image:', error)
        return null
    }
}

/**
 * Downloads file content from container file citation
 */
export const downloadContainerFile = async (
    containerId: string,
    fileId: string,
    filename: string,
    modelNodeData: INodeData,
    options: ICommonObject
): Promise<{ filePath: string; totalSize: number } | null> => {
    try {
        const credentialData = await getCredentialData(modelNodeData.credential ?? '', options)
        const openAIApiKey = getCredentialParam('openAIApiKey', credentialData, modelNodeData)

        if (!openAIApiKey) {
            console.warn('No OpenAI API key available for downloading container file')
            return null
        }

        // Download the file using OpenAI Container API
        const response = await fetch(`https://api.openai.com/v1/containers/${containerId}/files/${fileId}/content`, {
            method: 'GET',
            headers: {
                Accept: '*/*',
                Authorization: `Bearer ${openAIApiKey}`
            }
        })

        if (!response.ok) {
            console.warn(
                `Failed to download container file ${fileId} from container ${containerId}: ${response.status} ${response.statusText}`
            )
            return null
        }

        // Extract the binary data from the Response object
        const data = await response.arrayBuffer()
        const dataBuffer = Buffer.from(data)
        const mimeType = getMimeTypeFromFilename(filename)

        // Store the file using the same storage utility as OpenAIAssistant
        const { path, totalSize } = await addSingleFileToStorage(
            mimeType,
            dataBuffer,
            filename,
            options.orgId,
            options.chatflowid,
            options.chatId
        )

        return { filePath: path, totalSize }
    } catch (error) {
        console.error('Error downloading container file:', error)
        return null
    }
}

/**
 * Replace inlineData base64 with file references in the response content
 */
export const replaceInlineDataWithFileReferences = (
    response: AIMessageChunk,
    savedInlineImages: Array<{ filePath: string; fileName: string; mimeType: string }>
): void => {
    // Check if content is an array
    if (!Array.isArray(response.content)) {
        return
    }

    // Replace base64 data with file references in response content
    let savedImageIndex = 0
    for (let i = 0; i < response.content.length; i++) {
        const contentItem = response.content[i]
        if (
            typeof contentItem === 'object' &&
            contentItem.type === 'inlineData' &&
            contentItem.inlineData &&
            savedImageIndex < savedInlineImages.length
        ) {
            const savedImage = savedInlineImages[savedImageIndex]
            // Replace with file reference
            response.content[i] = {
                type: 'stored-file',
                name: savedImage.fileName,
                mime: savedImage.mimeType,
                path: savedImage.filePath
            }
            savedImageIndex++
        }
    }

    // Clear the inlineData from response_metadata to avoid duplication
    if (response.response_metadata?.inlineData) {
        delete response.response_metadata.inlineData
    }
}

/**
 * Extracts artifacts from response metadata (both annotations and built-in tools)
 */
export const extractArtifactsFromResponse = async (
    responseMetadata: any,
    modelNodeData: INodeData,
    options: ICommonObject
): Promise<{
    artifacts: any[]
    fileAnnotations: any[]
    savedInlineImages?: Array<{ filePath: string; fileName: string; mimeType: string }>
}> => {
    const artifacts: any[] = []
    const fileAnnotations: any[] = []
    const savedInlineImages: Array<{ filePath: string; fileName: string; mimeType: string }> = []

    // Handle Gemini inline data (image generation)
    if (responseMetadata?.inlineData && Array.isArray(responseMetadata.inlineData)) {
        for (const inlineItem of responseMetadata.inlineData) {
            if (inlineItem.type === 'gemini_inline_data' && inlineItem.data && inlineItem.mimeType) {
                try {
                    const savedImageResult = await saveGeminiInlineImage(inlineItem, options)
                    if (savedImageResult) {
                        // Create artifact in the same format as other image artifacts
                        const fileType = getArtifactTypeFromFilename(savedImageResult.fileName)
                        artifacts.push({
                            type: fileType,
                            data: savedImageResult.filePath
                        })

                        // Track saved image for replacing base64 data in content
                        savedInlineImages.push({
                            filePath: savedImageResult.filePath,
                            fileName: savedImageResult.fileName,
                            mimeType: inlineItem.mimeType
                        })
                    }
                } catch (error) {
                    console.error('Error processing Gemini inline image artifact:', error)
                }
            }
        }
    }

    if (!responseMetadata?.output || !Array.isArray(responseMetadata.output)) {
        return { artifacts, fileAnnotations, savedInlineImages: savedInlineImages.length > 0 ? savedInlineImages : undefined }
    }

    for (const outputItem of responseMetadata.output) {
        // Handle container file citations from annotations
        if (outputItem.type === 'message' && outputItem.content && Array.isArray(outputItem.content)) {
            for (const contentItem of outputItem.content) {
                if (contentItem.annotations && Array.isArray(contentItem.annotations)) {
                    for (const annotation of contentItem.annotations) {
                        if (annotation.type === 'container_file_citation' && annotation.file_id && annotation.filename) {
                            try {
                                // Download and store the file content
                                const downloadResult = await downloadContainerFile(
                                    annotation.container_id,
                                    annotation.file_id,
                                    annotation.filename,
                                    modelNodeData,
                                    options
                                )

                                if (downloadResult) {
                                    const fileType = getArtifactTypeFromFilename(annotation.filename)

                                    if (fileType === 'png' || fileType === 'jpeg' || fileType === 'jpg') {
                                        const artifact = {
                                            type: fileType,
                                            data: downloadResult.filePath
                                        }

                                        artifacts.push(artifact)
                                    } else {
                                        fileAnnotations.push({
                                            filePath: downloadResult.filePath,
                                            fileName: annotation.filename
                                        })
                                    }
                                }
                            } catch (error) {
                                console.error('Error processing annotation:', error)
                            }
                        }
                    }
                }
            }
        }

        // Handle built-in tool artifacts (like image generation)
        if (outputItem.type === 'image_generation_call' && outputItem.result) {
            try {
                const savedImageResult = await saveBase64Image(outputItem, options)
                if (savedImageResult) {
                    // Replace the base64 result with the file path in the response metadata
                    outputItem.result = savedImageResult.filePath

                    // Create artifact in the same format as other image artifacts
                    const fileType = getArtifactTypeFromFilename(savedImageResult.fileName)
                    artifacts.push({
                        type: fileType,
                        data: savedImageResult.filePath
                    })
                }
            } catch (error) {
                console.error('Error processing image generation artifact:', error)
            }
        }
    }

    return { artifacts, fileAnnotations, savedInlineImages: savedInlineImages.length > 0 ? savedInlineImages : undefined }
}

/**
 * Add image artifacts from previous assistant messages as user messages
 * This allows the LLM to see and reference the generated images in the conversation
 * Messages are marked with a special flag for later removal
 */
export const addImageArtifactsToMessages = async (messages: BaseMessageLike[], options: ICommonObject): Promise<void> => {
    const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp']
    const messagesToInsert: Array<{ index: number; message: any }> = []

    // Iterate through messages to find assistant messages with image artifacts
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i] as any

        // Check if this is an assistant message with artifacts
        if (
            (message.role === 'assistant' || message.role === 'ai') &&
            message.additional_kwargs?.artifacts &&
            Array.isArray(message.additional_kwargs.artifacts)
        ) {
            const artifacts = message.additional_kwargs.artifacts
            const imageArtifacts: Array<{ type: string; name: string; mime: string }> = []

            // Extract image artifacts
            for (const artifact of artifacts) {
                if (artifact.type && artifact.data) {
                    // Check if this is an image artifact by file type
                    if (imageExtensions.includes(artifact.type.toLowerCase())) {
                        // Extract filename from the file path
                        const fileName = artifact.data.split('/').pop() || artifact.data
                        const mimeType = `image/${artifact.type.toLowerCase()}`

                        imageArtifacts.push({
                            type: 'stored-file',
                            name: fileName,
                            mime: mimeType
                        })
                    }
                }
            }

            // If we found image artifacts, prepare to insert a user message after this assistant message
            if (imageArtifacts.length > 0) {
                // Check if the next message already contains these image artifacts to avoid duplicates
                const nextMessage = messages[i + 1] as any
                const shouldInsert =
                    !nextMessage ||
                    nextMessage.role !== 'user' ||
                    !Array.isArray(nextMessage.content) ||
                    !nextMessage.content.some(
                        (item: any) =>
                            (item.type === 'stored-file' || item.type === 'image_url') &&
                            imageArtifacts.some((artifact) => {
                                // Compare with and without FILE-STORAGE:: prefix
                                const artifactName = artifact.name.replace('FILE-STORAGE::', '')
                                const itemName = item.name?.replace('FILE-STORAGE::', '') || ''
                                return artifactName === itemName
                            })
                    )

                if (shouldInsert) {
                    messagesToInsert.push({
                        index: i + 1,
                        message: {
                            role: 'user',
                            content: imageArtifacts,
                            _isTemporaryImageMessage: true // Mark for later removal
                        }
                    })
                }
            }
        }
    }

    // Insert messages in reverse order to maintain correct indices
    for (let i = messagesToInsert.length - 1; i >= 0; i--) {
        const { index, message } = messagesToInsert[i]
        messages.splice(index, 0, message)
    }

    // Convert stored-file references to base64 image_url format
    if (messagesToInsert.length > 0) {
        const { updatedMessages } = await processMessagesWithImages(messages, options)
        // Replace the messages array content with the updated messages
        messages.length = 0
        messages.push(...updatedMessages)
    }
}

/**
 * Updates the flow state with new values
 */
export const updateFlowState = (state: ICommonObject, updateState: IFlowState[]): ICommonObject => {
    let newFlowState: Record<string, any> = {}
    for (const state of updateState) {
        newFlowState[state.key] = state.value
    }

    return {
        ...state,
        ...newFlowState
    }
}

export const listFlows = async (options: ICommonObject): Promise<INodeOptionsValue[]> => {
    const returnData: INodeOptionsValue[] = []

    const appDataSource = options.appDataSource as DataSource
    const databaseEntities = options.databaseEntities as IDatabaseEntity
    if (appDataSource === undefined || !appDataSource) {
        return returnData
    }

    const searchOptions = options.searchOptions || {}
    const chatflows = await appDataSource.getRepository(databaseEntities['ChatFlow']).findBy(searchOptions)

    for (let i = 0; i < chatflows.length; i += 1) {
        let cfType = 'Chatflow'
        if (chatflows[i].type === 'AGENTFLOW') {
            cfType = 'Agentflow V2'
        } else if (chatflows[i].type === 'MULTIAGENT') {
            cfType = 'Agentflow V1'
        }
        const data = {
            label: chatflows[i].name,
            name: chatflows[i].id,
            description: cfType
        } as INodeOptionsValue
        returnData.push(data)
    }

    // order by label
    return returnData.sort((a, b) => a.label.localeCompare(b.label))
}

// Message contents pass through turndown in resolveVariables, which escapes markdown characters and collapses whitespace
const normalizeForComparison = (text: string): string =>
    text
        .replace(/\\([\\`*_{}[\]()#+\-.!>~|=])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()

export const countTrailingHistoryCopy = (messages: { role: string; content: string }[], history: IMessage[]): number => {
    const expected = history
        .filter((msg) => msg.content)
        .map((msg) => ({
            role: ['apiMessage', 'assistant'].includes(msg.role as string) ? 'assistant' : 'user',
            content: normalizeForComparison(msg.content as string)
        }))
    if (!expected.length || expected.length > messages.length) return 0
    const tail = messages.slice(-expected.length)
    const isCopy = tail.every(
        (msg, i) =>
            msg.role === expected[i].role && typeof msg.content === 'string' && normalizeForComparison(msg.content) === expected[i].content
    )
    return isCopy ? expected.length : 0
}

// A memory-off node fed from the token history keeps its message list as sent: VoIP sends its whole call there
export const trimTrailingHistoryCopy = <T extends { role: string; content: string }>(
    messages: T[],
    { enableMemory, nodeLabel, options }: { enableMemory: boolean; nodeLabel: string; options: ICommonObject }
): T[] => {
    if (!enableMemory && options.historySource !== 'client') return messages
    const copyLength = countTrailingHistoryCopy(messages, (options.pastChatHistory as IMessage[]) ?? [])
    if (!copyLength) return messages
    ;(options.logger ?? console).warn(
        `[agentflow]: ${nodeLabel}: removed the last ${copyLength} messages of its message list because they repeat the conversation history`
    )
    return messages.slice(0, messages.length - copyLength)
}

export type CheckpointHistoryReference = { history: [number, number] }

export interface IAgentResumeCheckpoint {
    /** Length of the history the stopped turn started with (added by the server) */
    historyLength?: number
    conversation: Array<CheckpointHistoryReference | ICommonObject>
    toolCallMessage: ICommonObject
}

const isHistoryReference = (item: unknown): item is CheckpointHistoryReference =>
    Boolean(item) && Array.isArray((item as CheckpointHistoryReference).history) && (item as ICommonObject).role === undefined

/**
 * Replaces each run of prompt messages that copies pastChatHistory[i..j) with { history: [i, j] }, so a paused run keeps only
 * the messages the history lacks. Only exact copies become references, which a resume expands back to the same messages.
 */
export const toCheckpointConversation = (
    messages: BaseMessageLike[],
    pastChatHistory: BaseMessageLike[]
): IAgentResumeCheckpoint['conversation'] => {
    const conversation: IAgentResumeCheckpoint['conversation'] = []
    let i = 0
    while (i < messages.length) {
        let bestStart = -1
        let bestLength = 0
        for (let start = 0; start < pastChatHistory.length; start++) {
            let length = 0
            while (
                i + length < messages.length &&
                start + length < pastChatHistory.length &&
                isEqual(messages[i + length], pastChatHistory[start + length])
            ) {
                length++
            }
            if (length > bestLength) {
                bestStart = start
                bestLength = length
            }
        }
        if (bestLength) {
            conversation.push({ history: [bestStart, bestStart + bestLength] })
            i += bestLength
        } else {
            conversation.push(messages[i] as ICommonObject)
            i++
        }
    }
    return conversation
}

export const fromCheckpointConversation = (
    conversation: IAgentResumeCheckpoint['conversation'],
    pastChatHistory: BaseMessageLike[]
): BaseMessageLike[] =>
    conversation.flatMap((item) => {
        if (!isHistoryReference(item)) return [cloneDeep(item) as BaseMessageLike]
        const [start, end] = item.history
        if (end > pastChatHistory.length) {
            throw new Error(`The paused run refers to history messages ${start}-${end}, but the history holds ${pastChatHistory.length}`)
        }
        return cloneDeep(pastChatHistory.slice(start, end))
    })
