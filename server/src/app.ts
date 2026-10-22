import cors from "cors";
import express from "express";
import { Store } from "./services/database.js";
import { createApiRouter, errorHandler } from "./routes/api.js";
import type { PaymentProvider } from "./services/paypal.js";

export function createApp(
  store = new Store(process.env.DATABASE_PATH ?? "data/agentguard.sqlite"),
  payments?: PaymentProvider,
) {
  const app = express();
  app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:5173" }));
  app.use(express.json({ limit: "32kb" }));
  app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
  app.use("/api", createApiRouter(store, payments));
  app.use(errorHandler);
  return { app, store };
}
