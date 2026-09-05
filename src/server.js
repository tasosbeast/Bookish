import { app } from './app.js';
import { prisma } from './lib/prisma.js';
import { env } from './config/env.js';

await prisma.$connect();
const server = app.listen(env.PORT, () => console.log(`Bookish API listening on port ${env.PORT}`));
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 10000).unref();
  server.close(async () => {
    await prisma.$disconnect();
    clearTimeout(deadline);
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('error', async error => {
  console.error({ code: error.code, message: 'HTTP server failed' });
  await prisma.$disconnect();
  process.exit(1);
});
