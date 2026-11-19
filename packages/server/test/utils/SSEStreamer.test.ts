import { Response } from 'express'
import { SSEStreamer } from '../../src/utils/SSEStreamer'

interface RecordedSSEEvent {
    event: string
    data: any
}

function createMockResponse() {
    const chunks: string[] = []
    let ended = false
    const res = {
        write: jest.fn((chunk: string) => {
            chunks.push(chunk)
            return true
        }),
        end: jest.fn((chunk?: string) => {
            if (chunk) chunks.push(chunk)
            ended = true
        })
    }

    const parseEvents = (): RecordedSSEEvent[] => {
        const joined = chunks.join('')
        const events: RecordedSSEEvent[] = []
        for (const frame of joined.split('\n\n')) {
            if (!frame.trim()) continue
            for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue
                const raw = line.slice(5).trim()
                if (raw) {
                    events.push(JSON.parse(raw))
                }
            }
        }
        return events
    }

    return {
        res: res as unknown as Response,
        writeMock: res.write,
        endMock: res.end,
        isEnded: () => ended,
        parseEvents
    }
}

describe('SSEStreamer', () => {
    it('supports client lifecycle and ignores unknown or removed clients', () => {
        const streamer = new SSEStreamer()
        const mockRes = createMockResponse()

        // No-op before client registration
        expect(() => {
            streamer.streamStartEvent('missing', 'ignored')
            streamer.streamTokenEvent('missing', 'ignored')
            streamer.streamAgentFlowEvent('missing', 'INPROGRESS')
            streamer.removeClient('missing')
        }).not.toThrow()
        expect(mockRes.writeMock).not.toHaveBeenCalled()

        streamer.addClient('chat-1', mockRes.res)
        streamer.streamTokenEvent('chat-1', 'hello')
        streamer.removeClient('chat-1')

        expect(mockRes.isEnded()).toBe(true)
        expect(mockRes.endMock).toHaveBeenCalledTimes(1)

        // No-op after client removal
        const writesBefore = mockRes.writeMock.mock.calls.length
        streamer.streamTokenEvent('chat-1', 'after-close')
        streamer.removeClient('chat-1')
        expect(mockRes.writeMock).toHaveBeenCalledTimes(writesBefore)
        expect(mockRes.endMock).toHaveBeenCalledTimes(1)
    })

    it('deduplicates streamStartEvent per client', () => {
        const streamer = new SSEStreamer()
        const mockRes = createMockResponse()

        streamer.addExternalClient('chat-ext', mockRes.res)
        streamer.streamStartEvent('chat-ext', 'first')
        streamer.streamStartEvent('chat-ext', 'second')
        streamer.removeClient('chat-ext')

        const events = mockRes.parseEvents()
        expect(events).toEqual([
            { event: 'start', data: 'first' },
            { event: 'end', data: '[DONE]' }
        ])
    })

    it('streams token, agentflow, action, metadata, and error events in order', () => {
        const streamer = new SSEStreamer()
        const mockRes = createMockResponse()

        streamer.addClient('chat-2', mockRes.res)
        streamer.streamAgentFlowEvent('chat-2', 'INPROGRESS')
        streamer.streamNextAgentFlowEvent('chat-2', { nodeId: 'n1', nodeLabel: 'Node 1', status: 'INPROGRESS' })
        streamer.streamTokenEvent('chat-2', 'Hello ')
        streamer.streamTokenEvent('chat-2', 'world')
        streamer.streamActionEvent('chat-2', { id: 'act-1', elements: [] })
        streamer.streamMetadataEvent('chat-2', {
            chatId: 'chat-2',
            chatMessageId: 'msg-1',
            question: 'hi',
            sessionId: 'sess-1',
            memoryType: 'buffer',
            followUpPrompts: '["Next?"]',
            flowVariables: '{"k":"v"}',
            ignoredExtraField: 'should-not-appear'
        })
        streamer.streamErrorEvent('chat-2', 'Something failed')
        streamer.removeClient('chat-2')

        expect(mockRes.parseEvents()).toEqual([
            { event: 'agentFlowEvent', data: 'INPROGRESS' },
            { event: 'nextAgentFlow', data: { nodeId: 'n1', nodeLabel: 'Node 1', status: 'INPROGRESS' } },
            { event: 'token', data: 'Hello ' },
            { event: 'token', data: 'world' },
            { event: 'action', data: { id: 'act-1', elements: [] } },
            {
                event: 'metadata',
                data: {
                    chatId: 'chat-2',
                    chatMessageId: 'msg-1',
                    question: 'hi',
                    sessionId: 'sess-1',
                    memoryType: 'buffer',
                    followUpPrompts: ['Next?'],
                    flowVariables: { k: 'v' }
                }
            },
            { event: 'error', data: 'Something failed' },
            { event: 'end', data: '[DONE]' }
        ])
    })

    it('flushes the latest agentFlowExecutedData right before end on removeClient', () => {
        const streamer = new SSEStreamer()
        const mockRes = createMockResponse()

        streamer.addClient('chat-3', mockRes.res)
        streamer.streamAgentFlowExecutedDataEvent('chat-3', [{ nodeId: 'start', status: 'FINISHED' }])
        streamer.streamAgentFlowExecutedDataEvent('chat-3', [
            { nodeId: 'start', status: 'FINISHED' },
            { nodeId: 'reply', status: 'FINISHED' }
        ])
        expect(mockRes.parseEvents()).toEqual([])

        streamer.removeClient('chat-3')

        expect(mockRes.parseEvents()).toEqual([
            {
                event: 'agentFlowExecutedData',
                data: [
                    { nodeId: 'start', status: 'FINISHED' },
                    { nodeId: 'reply', status: 'FINISHED' }
                ]
            },
            { event: 'end', data: '[DONE]' }
        ])
    })
})
