import 'dotenv/config';
import { startWebServer } from './bot.js';

const PORT = parseInt(process.env.PORT) || 3000;

console.log(`🚀  Starting Lanx Bot...`);
console.log(`📡  PORT = ${PORT}`);

async function main() {
  await startWebServer(PORT);
}

main().catch((err) => {
  console.error('❌  Fatal startup error:', err);
  process.exit(1);
});
