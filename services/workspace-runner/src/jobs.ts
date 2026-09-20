import { loadConfig } from './config.js';
import { listenProcessSupervisor, prepareSupervisorRestart } from './process-supervisor.js';

const app = await listenProcessSupervisor(loadConfig());
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// A release reload waits for jobs and interpreters; a service restart is an explicit interruption.
let requested = false;
const restartWhenIdle = () => {
  if (requested && !stopping && prepareSupervisorRestart(app)) void shutdown();
};
process.on('SIGUSR2', () => {
  requested = true;
  restartWhenIdle();
});
setInterval(restartWhenIdle, 1000).unref();
