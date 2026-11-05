import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { hash, randomToken } from "../src/crypto";
import { Permissions } from "../src/contracts";
export async function cmsRuntime(port = 8788) {
    const token = randomToken();
    const mf = new Miniflare(
        convertV4MiniflareOptions({
            host: "127.0.0.1",
            port,
            workers: [
                {
                    name: "cms",
                    modules: true,
                    scriptPath: "dist-bridge/worker.js",
                    compatibilityDate: "2026-11-04",
                    compatibilityFlags: ["nodejs_compat"],
                    serviceBindings: { DEVICE_API: "backend" },
                    bindings: {
                        CMS_SERVICE_TOKEN: token,
                        CMS_POLICY_SERVICE_TOKEN: token,
                        CMS_ACTOR_ID: "local_operator",
                        CMS_ACTOR_NAME: "Quản trị viên thử nghiệm",
                        CMS_ORIGIN: "http://127.0.0.1:" + port,
                        CMS_MODE: "local",
                        CMS_SITE_ID: "site",
                        CMS_SCOPE_ID: "scope",
                    },
                    assets: {
                        directory: "dist-cms",
                        binding: "ASSETS",
                        run_worker_first: ["/cms-api", "/cms-api/*"],
                        routerConfig: { has_user_worker: true },
                        assetConfig: { not_found_handling: "single-page-application" },
                    },
                },
                {
                    name: "backend",
                    modules: true,
                    scriptPath: "dist/index.js",
                    compatibilityDate: "2026-11-04",
                    compatibilityFlags: ["nodejs_compat"],
                    routes: ["*/api/*", "*/checkin*", "*/health", "*/openapi.json"],
                    durableObjects: { DEVICES: { className: "DeviceDO", useSQLite: true } },
                    d1Databases: ["DB"],
                    r2Buckets: ["FIRMWARE"],
                    bindings: {
                        CONFIG_ENCRYPTION_KEY: randomToken(),
                        REGISTRATION_SITE_ID: "site",
                        REGISTRATION_SCOPE_ID: "scope",
                        REGISTRATION_SCOPE_NAME: "Bảo tàng thử nghiệm",
                    },
                },
            ],
        })
    );
    try {
        await mf.ready;
        const db = await mf.getD1Database("DB", "backend");
        const sql = await readFile("schema.sql", "utf8");
        await db.batch(
            sql
                .split(";")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((s) => db.prepare(s))
        );
        await db
            .prepare("INSERT INTO service_credentials VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(
                "cms",
                "cms",
                "OPERATOR",
                await hash(token),
                JSON.stringify(Permissions.options),
                '["site"]',
                '["scope"]',
                null,
                Date.now()
            )
            .run();
        const base = "http://127.0.0.1:" + port;
        const context = await fetch(base + "/cms-api/context");
        if (!context.ok)
            throw new Error(
                "Bridge context failed: " + context.status + " " + (await context.text())
            );
        const data = (await context.json()) as { sites?: string[] };
        if (!data.sites?.length) throw new Error("Missing context grants");
        return { mf, base };
    } catch (e) {
        await mf.dispose();
        throw e;
    }
}
