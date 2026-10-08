// Keep the legacy bootstrap (and its VM/proxy/payment imports) outside Hambin mode.
if (process.env.HAMBIN_MODE === "true") {
  const { start } = await import("./hambin/main.ts");
  await start();
} else {
  await import("./legacy.ts");
}
export {};
