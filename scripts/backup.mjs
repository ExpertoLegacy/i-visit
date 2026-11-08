// Takes a backup now. Usage: npm run backup
import '../src/env.js';
import { createBackup, BACKUP_DIR } from '../src/backup.js';

const backup = createBackup('manual');
console.log(`Saved ${backup.name} (${Math.ceil(backup.size / 1024)} KB) in ${BACKUP_DIR}`);
