import { recordUptime } from './uptime';
import { runMemoryWatchdog } from './watchdog';
recordUptime();
runMemoryWatchdog();
