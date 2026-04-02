import * as Server from '../index'
import * as DataSource from '../DataSource'
import logger from '../utils/logger'
import { BaseCommand } from './base'
import cluster from 'node:cluster'
import os from 'node:os'

async function runMigrations() {
    await DataSource.init()
    await DataSource.getDataSource().initialize()
    logger.info('📦 [server]: Data Source initialized successfully')
    await DataSource.getDataSource().runMigrations({ transaction: 'each' })
    logger.info('🔄 [server]: Database migrations completed successfully')
    await DataSource.getDataSource().destroy()
}

export default class Start extends BaseCommand {
    async run(): Promise<void> {
        if (cluster.isPrimary) {
            logger.info('Starting Flowise Primary Process...')

            // Run migrations before forking workers
            await runMigrations()

            const desiredWorkerCount = Number.parseInt(process.env.MULTI_NODES || '0') || Math.ceil(os.cpus().length / 2)
            const numWorkers = Math.min(Math.max(1, desiredWorkerCount), os.cpus().length)
            logger.info(`Forking ${numWorkers} workers...`)

            for (let i = 0; i < numWorkers; i++) {
                cluster.fork()
            }

            cluster.on('exit', (worker, code, signal) => {
                logger.warn(`Worker ${worker.process.pid} died. Restarting...`)
                cluster.fork()
            })
        } else {
            logger.info(`Starting Worker ${process.pid}...`)
            await DataSource.init()
            await Server.start()
        }
    }

    async catch(error: Error) {
        if (error.stack) logger.error(`[PID ${process.pid}] ${error.stack}`)
        await new Promise((resolve) => setTimeout(resolve, 1000))
        await this.failExit()
    }

    async stopProcess() {
        try {
            logger.info(`Shutting down process ${process.pid}...`)

            if (cluster.isPrimary) {
                for (const id in cluster.workers) {
                    cluster.workers[id]?.kill()
                }
            } else {
                const serverApp = Server.getInstance()
                if (serverApp) await serverApp.stopApp()
            }
        } catch (error) {
            logger.error('Shutdown error...', error)
            await this.failExit()
        }

        await this.gracefullyExit()
    }
}
