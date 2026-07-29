// Prisma 7 moved the connection URL out of schema.prisma and into this file. It is read by
// the Prisma CLI only (generate / migrate / studio); the running application opens its own
// connection through the pg driver adapter in src/database/prisma.service.ts.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
