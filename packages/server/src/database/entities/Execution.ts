import { Entity, Column, Index, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm'
import { IExecution, ExecutionState } from '../../Interface'
import { ChatFlow } from './ChatFlow'
import { gzipSync, gunzipSync } from 'node:zlib'

@Entity()
export class Execution implements IExecution {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column({ type: 'text' })
    executionData: string

    @Column({ type: process.env.DATABASE_TYPE === 'postgres' ? 'bytea' : 'blob', nullable: true })
    executionDataBlob?: Buffer

    @Column()
    state: ExecutionState

    @Index()
    @Column({ type: 'uuid' })
    agentflowId: string

    @Index()
    @Column({ type: 'varchar' })
    sessionId: string

    @Column({ nullable: true, type: 'text' })
    action?: string

    @Column({ nullable: true })
    isPublic?: boolean

    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    createdDate: Date

    @Column({ type: 'timestamp' })
    @UpdateDateColumn()
    updatedDate: Date

    @Column()
    stoppedDate: Date

    @ManyToOne(() => ChatFlow)
    @JoinColumn({ name: 'agentflowId' })
    agentflow: ChatFlow

    @Column({ nullable: false, type: 'text' })
    workspaceId: string
}

export const Compression = {
    compress: (data: any) => {
        return gzipSync(Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)))
    },
    decompress: (buffer: Buffer) => {
        return gunzipSync(buffer).toString()
    }
}
