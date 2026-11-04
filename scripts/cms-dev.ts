import { cmsRuntime } from "./cms-runtime";
const runtime = await cmsRuntime();
console.log("CMS local: " + runtime.base + " — isolated temporary database; stop with Ctrl+C.");
const stop = async () => {
    await runtime.mf.dispose();
    process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
