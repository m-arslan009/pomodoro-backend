import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/*
 * Global because every repository needs the same client instance, and a second PrismaClient
 * would open a second connection pool for no benefit.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
