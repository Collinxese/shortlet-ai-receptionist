import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

try {
  const config = loadConfig();
  const app = await buildApp(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1; });
    });
  }
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch {
    app.log.error('Could not start HTTP server');
    await app.close();
    process.exitCode = 1;
  }
} catch {
  console.error('Startup failed. Check environment configuration and installed dependencies.');
  process.exitCode = 1;
}
