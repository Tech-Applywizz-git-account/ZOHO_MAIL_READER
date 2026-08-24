import express from "express";
import path from "path";
import { errorHandler } from "./middleware/errorHandler";
import healthRoutes from "./routes/health.routes";
import zohoRoutes from "./routes/zoho.routes";

export function createApp() {
  const app = express();
  const publicDir = path.join(process.cwd(), "public");

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(publicDir));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.use(healthRoutes);
  app.use("/api/zoho", zohoRoutes);
  app.use(errorHandler);

  return app;
}
