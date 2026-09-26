import 'dotenv/config';
import { startWebServer } from './bot.js';

const PORT = parseInt(process.env.PORT) || 3000;

console.log(`🚀  Starting Lanx Bot...`);
console.log(`📡  PORT = ${PORT}`);

async function main() {
  await startWebServer(PORT);
}

process.on('unhandledRejection', (err) => {
  console.error('❌  Unhandled rejection (server staying up):', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('❌  Uncaught exception (server staying up):', err && err.message ? err.message : err);
});

main().catch((err) => {
  console.error('❌  Fatal startup error:', err);
  process.exit(1);
});
