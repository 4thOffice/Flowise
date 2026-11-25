import {
    ICommonObject,
    IDatabaseEntity,
    INode,
    INodeData,
    INodeOptionsValue,
    INodeParams,
    IServerSideEventStreamer
} from '../../../src/Interface'
import { updateFlowState } from '../utils'
import { processTemplateVariables } from '../../../src/utils'
import { DataSource } from 'typeorm'
import { BaseRetriever } from '@langchain/core/retrievers'
import { Document, DocumentInterface } from '@langchain/core/documents'
import { VectorStoreRetriever } from '@langchain/core/vectorstores'

interface IKnowledgeBase {
    documentStore: string
}

interface IRetrieverHit {
    id: string | null
    score: number | null
    pageContent: string
    metadata: Record<string, any>
}

// MMR re-ranks for diversity and gives no scores; a scored similarity search would return other documents.
const isSimilarityRetriever = (retriever: BaseRetriever): retriever is VectorStoreRetriever =>
    'vectorStore' in retriever && (retriever as VectorStoreRetriever).searchType !== 'mmr'

const searchHits = async (retriever: BaseRetriever, query: string, signal?: AbortSignal): Promise<IRetrieverHit[]> => {
    const results: [DocumentInterface, number | null][] = isSimilarityRetriever(retriever)
        ? await retriever.vectorStore.similaritySearchWithScore(query, retriever.k, retriever.filter)
        : (await retriever.invoke(query, { signal })).map((doc): [DocumentInterface, null] => [doc, null])
    return results.map(([doc, score]) => ({ id: doc.id ?? null, score, pageContent: doc.pageContent, metadata: doc.metadata }))
}

class Retriever_Agentflow implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    color: string
    hideOutput: boolean
    hint: string
    baseClasses: string[]
    documentation?: string
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'Retriever'
        this.name = 'retrieverAgentflow'
        this.version = 1.2
        this.type = 'Retriever'
        this.category = 'Agent Flows'
        this.description = 'Retrieve information from vector database'
        this.baseClasses = [this.type]
        this.color = '#b8bedd'
        this.inputs = [
            {
                label: 'Knowledge (Document Stores)',
                name: 'retrieverKnowledgeDocumentStores',
                type: 'array',
                description: 'Document stores to retrieve information from. Document stores must be upserted in advance.',
                array: [
                    {
                        label: 'Document Store',
                        name: 'documentStore',
                        type: 'asyncOptions',
                        loadMethod: 'listStores'
                    }
                ]
            },
            {
                label: 'Retriever Query',
                name: 'retrieverQuery',
                type: 'string',
                placeholder: 'Enter your query here',
                rows: 4,
                acceptVariable: true
            },
            {
                label: 'Top K',
                name: 'retrieverTopK',
                description: "Number of results to fetch from each document store. Defaults to the store's own Top K",
                type: 'number',
                optional: true
            },
            {
                label: 'Output Format',
                name: 'outputFormat',
                type: 'options',
                options: [
                    { label: 'Text', name: 'text' },
                    { label: 'Text with Metadata', name: 'textWithMetadata' },
                    { label: 'JSON Hits', name: 'jsonHits', description: 'JSON array of {id, score, pageContent, metadata}' }
                ],
                default: 'text'
            },
            {
                label: 'Weaviate metadata filter override',
                name: 'weaviateMetadataFilterOverride',
                type: 'string',
                acceptVariable: true,
                acceptNodeOutputAsVariable: true
            },
            {
                label: 'Update Flow State',
                name: 'retrieverUpdateState',
                description: 'Update runtime state during the execution of the workflow',
                type: 'array',
                optional: true,
                acceptVariable: true,
                array: [
                    {
                        label: 'Key',
                        name: 'key',
                        type: 'asyncOptions',
                        loadMethod: 'listRuntimeStateKeys'
                    },
                    {
                        label: 'Value',
                        name: 'value',
                        type: 'string',
                        acceptVariable: true,
                        acceptNodeOutputAsVariable: true
                    }
                ]
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        async listRuntimeStateKeys(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
            const previousNodes = options.previousNodes as ICommonObject[]
            const startAgentflowNode = previousNodes.find((node) => node.name === 'startAgentflow')
            const state = startAgentflowNode?.inputs?.startState as ICommonObject[]
            return state.map((item) => ({ label: item.key, name: item.key }))
        },
        async listStores(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
            const returnData: INodeOptionsValue[] = []

            const appDataSource = options.appDataSource as DataSource
            const databaseEntities = options.databaseEntities as IDatabaseEntity

            if (appDataSource === undefined || !appDataSource) {
                return returnData
            }

            const searchOptions = options.searchOptions || {}
            const stores = await appDataSource.getRepository(databaseEntities['DocumentStore']).findBy(searchOptions)
            for (const store of stores) {
                if (store.status === 'UPSERTED') {
                    const obj = {
                        name: `${store.id}:${store.name}`,
                        label: store.name,
                        description: store.description
                    }
                    returnData.push(obj)
                }
            }
            return returnData
        }
    }

    async run(nodeData: INodeData, input: string, options: ICommonObject): Promise<any> {
        const retrieverQuery = nodeData.inputs?.retrieverQuery as string
        const retrieverTopK = nodeData.inputs?.retrieverTopK
        const outputFormat = nodeData.inputs?.outputFormat as string
        const _retrieverUpdateState = nodeData.inputs?.retrieverUpdateState

        const state = options.agentflowRuntime?.state as ICommonObject
        const chatId = options.chatId as string
        const isLastNode = options.isLastNode as boolean
        const isStreamable = isLastNode && options.sseStreamer !== undefined

        const abortController = options.abortController as AbortController
        const query = retrieverQuery || input

        // Extract knowledge
        let docs: Document[] = []
        const hits: IRetrieverHit[] = []
        const knowledgeBases = nodeData.inputs?.retrieverKnowledgeDocumentStores as IKnowledgeBase[]
        if (knowledgeBases && knowledgeBases.length > 0) {
            for (const knowledgeBase of knowledgeBases) {
                const [storeId, _] = knowledgeBase.documentStore.split(':')

                const docStoreVectorInstanceFilePath = options.componentNodes['documentStoreVS'].filePath as string
                const docStoreVectorModule = await import(docStoreVectorInstanceFilePath)
                const newDocStoreVectorInstance = new docStoreVectorModule.nodeClass()
                const docStoreVectorInstance = (await newDocStoreVectorInstance.init(
                    {
                        ...nodeData,
                        inputs: {
                            ...nodeData.inputs,
                            selectedStore: storeId,
                            topKOverride: retrieverTopK
                        },
                        outputs: {
                            output: 'retriever'
                        }
                    },
                    '',
                    options
                )) as BaseRetriever

                if (outputFormat === 'jsonHits') {
                    hits.push(...(await searchHits(docStoreVectorInstance, query, abortController?.signal)))
                } else {
                    docs.push(...(await docStoreVectorInstance.invoke(query, { signal: abortController?.signal })))
                }
            }
        }

        const docsText = docs.map((doc) => doc.pageContent).join('\n')

        // Update flow state if needed
        let newState = { ...state }
        if (_retrieverUpdateState && Array.isArray(_retrieverUpdateState) && _retrieverUpdateState.length > 0) {
            newState = updateFlowState(state, _retrieverUpdateState)
        }

        try {
            let finalOutput = ''
            if (outputFormat === 'text') {
                finalOutput = docsText
            } else if (outputFormat === 'textWithMetadata') {
                finalOutput = JSON.stringify(docs, null, 2)
            } else if (outputFormat === 'jsonHits') {
                finalOutput = JSON.stringify(hits, null, 2)
            }

            if (isStreamable) {
                const sseStreamer: IServerSideEventStreamer = options.sseStreamer
                sseStreamer.streamTokenEvent(chatId, finalOutput)
            }

            newState = processTemplateVariables(newState, finalOutput)

            const returnOutput = {
                id: nodeData.id,
                name: this.name,
                input: {
                    question: query
                },
                output: {
                    content: finalOutput
                },
                state: newState
            }

            return returnOutput
        } catch (e) {
            throw new Error(e)
        }
    }
}

module.exports = { nodeClass: Retriever_Agentflow }
