import { startServer } from "./server.js";

const running = await startServer();
process.stdout.write(`howdy listening on ${running.url}\n`);

const shutdown = () => {
  void running.stop().then(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
