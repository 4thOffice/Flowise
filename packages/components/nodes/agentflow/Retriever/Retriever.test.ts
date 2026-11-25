import fs from 'fs'
import os from 'os'
import path from 'path'
import { Document } from '@langchain/core/documents'
import { FakeEmbeddings } from '@langchain/core/utils/testing'
import { VectorStore, VectorStoreRetriever } from '@langchain/core/vectorstores'
const { nodeClass: Retriever_Agentflow } = require('./Retriever')

class StubVectorStore extends VectorStore {
    constructor(private readonly results: [Document, number][]) {
        super(new FakeEmbeddings(), {})
    }
    _vectorstoreType() {
        return 'stub'
    }
    async addVectors() {}
    async addDocuments() {}
    async similaritySearchVectorWithScore(_query: number[], k: number): Promise<[Document, number][]> {
        return this.results.slice(0, k)
    }
    async maxMarginalRelevanceSearch(_query: string, options: { k: number }) {
        return this.results
            .slice(0, options.k)
            .map(([doc]) => doc)
            .reverse()
    }
}

const doc = (id: string, pageContent: string) => new Document({ id, pageContent, metadata: { source: `${id}.md` } })
const storeResults: Record<string, [Document, number][]> = {
    a: [
        [doc('a1', 'Opening hours'), 0.91],
        [doc('a2', 'Holidays'), 0.77],
        [doc('a3', 'Parking'), 0.4]
    ],
    b: [[doc('b1', 'Price list'), 0.66]]
}

const fakeNodesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retriever-node-test-'))
const fakeNode = (name: string, initGlobal: string) => {
    const filePath = path.join(fakeNodesDir, `${name}.js`)
    fs.writeFileSync(filePath, `module.exports = { nodeClass: class { async init(nodeData) { return global.${initGlobal}(nodeData) } } }`)
    return { name, label: name, category: 'test', inputs: [], filePath }
}
const componentNodes = {
    documentStoreVS: { filePath: require.resolve('../../vectorstores/DocumentStoreVS/DocStoreVector') },
    fakeEmbeddings: fakeNode('fakeEmbeddings', '__retrieverTestEmbeddings'),
    fakeVectorStore: fakeNode('fakeVectorStore', '__retrieverTestVectorStore')
}

const storeTopKs: unknown[] = []
;(global as any).__retrieverTestEmbeddings = () => new FakeEmbeddings()
;(global as any).__retrieverTestVectorStore = (nodeData: any) => {
    storeTopKs.push(nodeData.inputs.topK)
    return new VectorStoreRetriever({
        vectorStore: new StubVectorStore(storeResults[nodeData.inputs.storeKey]),
        k: parseFloat(nodeData.inputs.topK),
        searchType: nodeData.inputs.searchType
    })
}

const documentStore = (vectorStoreConfig: Record<string, string>) => ({
    embeddingConfig: JSON.stringify({ name: 'fakeEmbeddings', config: {} }),
    vectorStoreConfig: JSON.stringify({ name: 'fakeVectorStore', config: { topK: '2', ...vectorStoreConfig } })
})
const documentStores: Record<string, ReturnType<typeof documentStore>> = {
    faq: documentStore({ storeKey: 'a' }),
    prices: documentStore({ storeKey: 'b' }),
    faqMmr: documentStore({ storeKey: 'a', searchType: 'mmr' })
}

const run = async (inputs: Record<string, unknown>, stores = ['faq', 'prices']) => {
    storeTopKs.length = 0
    const result = await new Retriever_Agentflow().run(
        {
            id: 'retrieverAgentflow_0',
            label: 'Retriever 0',
            inputs: {
                retrieverKnowledgeDocumentStores: stores.map((id) => ({ documentStore: `${id}:${id}` })),
                retrieverQuery: 'When are you open?',
                ...inputs
            }
        },
        'question',
        {
            componentNodes,
            appDataSource: { getRepository: () => ({ findOneBy: async ({ id }: { id: string }) => documentStores[id] }) },
            databaseEntities: { DocumentStore: 'DocumentStore' },
            agentflowRuntime: { state: {} },
            chatId: 'chat',
            isLastNode: false
        }
    )
    return result.output.content as string
}

describe('Retriever node', () => {
    it('JSON Hits gives the id, score, text and metadata of each hit, store after store', async () => {
        expect(JSON.parse(await run({ outputFormat: 'jsonHits' }))).toEqual([
            { id: 'a1', score: 0.91, pageContent: 'Opening hours', metadata: { source: 'a1.md' } },
            { id: 'a2', score: 0.77, pageContent: 'Holidays', metadata: { source: 'a2.md' } },
            { id: 'b1', score: 0.66, pageContent: 'Price list', metadata: { source: 'b1.md' } }
        ])
    })

    it("Top K on the node replaces each store's own Top K", async () => {
        const hits = JSON.parse(await run({ outputFormat: 'jsonHits', retrieverTopK: 1 }))
        expect([hits.map((hit: any) => hit.id), storeTopKs]).toEqual([
            ['a1', 'b1'],
            [1, 1]
        ])
    })

    it("without Top K on the node, each store's own Top K applies", async () => {
        await run({ outputFormat: 'text' })
        expect(storeTopKs).toEqual(['2', '2'])
    })

    it('a store searched with MMR gives its documents in MMR order with a null score', async () => {
        expect(JSON.parse(await run({ outputFormat: 'jsonHits' }, ['faqMmr']))).toEqual([
            { id: 'a2', score: null, pageContent: 'Holidays', metadata: { source: 'a2.md' } },
            { id: 'a1', score: null, pageContent: 'Opening hours', metadata: { source: 'a1.md' } }
        ])
    })

    it('Text output joins the retrieved texts as before', async () => {
        expect(await run({ outputFormat: 'text' })).toBe('Opening hours\nHolidays\nPrice list')
    })
})
