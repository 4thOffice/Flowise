import { MigrationInterface, QueryRunner } from 'typeorm'

export class ExecutionDataCompressedBlob1775050098094 implements MigrationInterface {
    name = 'ExecutionDataCompressedBlob1775050098094'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "execution" ADD COLUMN "executionDataBlob" bytea;`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "execution" DROP COLUMN "executionDataBlob";`)
    }
}
