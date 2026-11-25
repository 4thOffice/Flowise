const mockQuery = jest.fn()
jest.mock('@qdrant/js-client-rest', () => ({
    QdrantClient: jest.fn().mockImplementation(() => ({
        getCollections: async () => ({ collections: [{ name: 'docs' }] }),
        query: mockQuery
    }))
}))

const { nodeClass: Qdrant_VectorStores } = require('./Qdrant')

const qdrantFilter = { must: [{ key: 'metadata.lang', match: { value: 'sl' } }] }

const initRetriever = () =>
    new Qdrant_VectorStores().init(
        {
            inputs: {
                qdrantServerUrl: 'http://localhost:6333',
                qdrantCollection: 'docs',
                embeddings: { embedQuery: async () => [0.1, 0.2] },
                topK: '2',
                qdrantFilter
            },
            outputs: { output: 'retriever' }
        },
        '',
        {}
    )

beforeEach(() => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({
        points: [
            { id: 'a3c1e2f4-0000-4000-8000-000000000001', score: 0.91, payload: { content: 'Opening hours', metadata: { lang: 'sl' } } },
            { id: 7, score: 0.42, payload: { content: 'Parking', metadata: { lang: 'sl' } } }
        ]
    })
})

describe('Qdrant retriever', () => {
    it('a scored search returns each point id and score with the retriever k and filter', async () => {
        const retriever = await initRetriever()
        const results = await retriever.vectorStore.similaritySearchWithScore('hours', retriever.k, retriever.filter)

        expect(mockQuery).toHaveBeenCalledWith('docs', {
            query: [0.1, 0.2],
            limit: 2,
            filter: qdrantFilter,
            with_payload: ['metadata', 'content'],
            with_vector: false
        })
        expect(results.map(([doc, score]: [any, number]) => [doc.id, score, doc.pageContent, doc.metadata])).toEqual([
            ['a3c1e2f4-0000-4000-8000-000000000001', 0.91, 'Opening hours', { lang: 'sl' }],
            ['7', 0.42, 'Parking', { lang: 'sl' }]
        ])
    })

    it('invoking the retriever returns the documents without ids, as before', async () => {
        const retriever = await initRetriever()
        const docs = await retriever.invoke('hours')

        expect(JSON.parse(JSON.stringify(docs))).toEqual([
            { pageContent: 'Opening hours', metadata: { lang: 'sl' } },
            { pageContent: 'Parking', metadata: { lang: 'sl' } }
        ])
    })
})
