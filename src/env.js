import { existsSync } from 'node:fs';
import process from 'node:process';

for (const file of ['.env', '.env.local']) {
  if (!existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    console.warn(`[env] could not load ${file}: ${err.message}`);
  }
}
