import { initializeMonitoring } from "./hambin/observability.ts";
initializeMonitoring();
const { start } = await import("./hambin/main.ts");
await start();
