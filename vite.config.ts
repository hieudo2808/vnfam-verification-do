import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import prefix from "postcss-prefix-selector";
import { resolve } from "node:path";
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "VITE_");
    return {
        root: "cms",
        envDir: "..",
        base: env.VITE_ADMIN_BASE_PATH || "/",
        plugins: [react(), tailwindcss()],
        resolve: { alias: { "@": resolve(process.cwd(), "cms/src") } },
        css: {
            postcss: {
                plugins: [
                    prefix({
                        prefix: ".vnfam-admin",
                        transform: (p: string, s: string) =>
                            s.startsWith(".vnfam-admin")
                                ? s
                                : s.includes(":root") || s.includes(":host")
                                  ? s.replace(/:root|:host/g, p)
                                  : p + " " + s,
                    }),
                ],
            },
        },
        build: { outDir: "../dist-cms", emptyOutDir: true },
        server: { host: "127.0.0.1", proxy: { "/cms-api": "http://127.0.0.1:8788" } },
    };
});
