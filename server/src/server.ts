
import "dotenv/config";
import { createApp } from "./app.js";

const { app, store } = createApp();
const port = Number(process.env.PORT ?? 3002);

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`AgentGuard API listening on port ${port}`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
