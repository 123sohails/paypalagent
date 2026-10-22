import "dotenv/config";
import { createApp } from "./app.js";

const { app, store } = createApp();
const port = Number(process.env.PORT ?? 3001);
const server = app.listen(port, () => {
  console.log(`AgentGuard API listening on http://localhost:${port}`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
