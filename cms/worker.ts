import { Hono } from "hono";
import { Id } from "../src/contracts";
import { DeviceDefaults } from "../src/cms-contracts";
export interface BridgeEnv {
    DEVICE_API: { fetch(request: Request): Promise<Response> };
    ASSETS?: { fetch(request: Request): Promise<Response> };
    CMS_SERVICE_TOKEN: string;
    CMS_POLICY_SERVICE_TOKEN?: string;
    CMS_ACTOR_ID: string;
    CMS_ACTOR_NAME?: string;
    CMS_ORIGIN: string;
    CMS_MODE: "local" | "protected" | "public-test";
    CMS_SITE_ID?: string;
    CMS_SCOPE_ID?: string;
    CMS_QR_BASE_URL?: string;
}
const routes: [string, RegExp][] = [
    [
        "GET",
        /^\/(context|device-summaries|device-registrations|audit-events|audit-summaries|check-ins|check-in-summaries|check-in-policy|time-settings|devices|firmware-releases)$/,
    ],
    ["POST", /^\/(devices|device-pairings|firmware-releases)$/],
    [
        "GET",
        /^\/devices\/[A-Za-z0-9_-]+(\/(overview|config|runtime-settings|registration|operations|events))?$/,
    ],
    ["GET", /^\/devices\/[A-Za-z0-9_-]+\/operations\/[A-Za-z0-9_-]+$/],
    ["PATCH", /^\/devices\/[A-Za-z0-9_-]+(\/(config|network-config))?$/],
    ["POST", /^\/devices\/[A-Za-z0-9_-]+\/(commands|upgrades|key-revocations)$/],
    ["DELETE", /^\/devices\/[A-Za-z0-9_-]+(\/credential)?$/],
    ["DELETE", /^\/device-pairings\/[A-Za-z0-9_-]+$/],
    ["POST", /^\/device-registrations\/[A-Za-z0-9_-]+\/approve$/],
    ["DELETE", /^\/device-registrations\/[A-Za-z0-9_-]+$/],
    ["PUT", /^\/devices\/[A-Za-z0-9_-]+\/firmware-target$/],
    ["GET", /^\/firmware-releases\/[A-Za-z0-9_-]+$/],
    ["PATCH", /^\/firmware-releases\/[A-Za-z0-9_-]+$/],
    ["PUT", /^\/firmware-releases\/[A-Za-z0-9_-]+\/binary$/],
    ["PATCH", /^\/(check-in-policy|time-settings)$/],
];
export function createBridge() {
    const app = new Hono<{ Bindings: BridgeEnv }>();
    app.all("/cms-api/*", async (c) => {
        const fail = (status: 401 | 403 | 404 | 503, code: string) =>
            c.json({ error: { code, message: code, requestId: crypto.randomUUID() } }, status);
        const url = new URL(c.req.url),
            path = url.pathname.slice("/cms-api".length);
        if (!routes.some(([method, pattern]) => method === c.req.method && pattern.test(path)))
            return fail(404, "NOT_FOUND");
        if (!["local", "protected", "public-test"].includes(c.env.CMS_MODE))
            return fail(503, "CMS_NOT_CONFIGURED");
        if (
            c.env.CMS_MODE === "local" &&
            !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )
            return fail(403, "LOCAL_ONLY");
        if (!c.env.CMS_ORIGIN || !Id.safeParse(c.env.CMS_ACTOR_ID).success)
            return fail(503, "CMS_NOT_CONFIGURED");
        if (url.origin !== c.env.CMS_ORIGIN) return fail(403, "ORIGIN_FORBIDDEN");
        if (c.req.header("origin") && c.req.header("origin") !== c.env.CMS_ORIGIN)
            return fail(403, "ORIGIN_FORBIDDEN");
        const policy =
            c.req.method === "PATCH" && ["/check-in-policy", "/time-settings"].includes(path);
        const token = policy ? c.env.CMS_POLICY_SERVICE_TOKEN : c.env.CMS_SERVICE_TOKEN;
        if (!token)
            return fail(policy ? 403 : 503, policy ? "POLICY_READ_ONLY" : "CMS_NOT_CONFIGURED");
        const headers = new Headers({
            authorization: "Bearer " + token,
            "x-actor-id": c.env.CMS_ACTOR_ID,
        });
        if (c.env.CMS_ACTOR_NAME)
            headers.set("x-actor-name", encodeURIComponent(c.env.CMS_ACTOR_NAME));
        for (const name of ["content-type", "content-length", "idempotency-key"]) {
            const v = c.req.header(name);
            if (v) headers.set(name, v);
        }
        const request = new Request("https://device-api.internal/api/admin" + path + url.search, {
            method: c.req.method,
            headers,
            body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
        });
        try {
            const response = await c.env.DEVICE_API.fetch(request);
            if (path === "/context" && response.ok) {
                const data = (await response.json()) as Record<string, unknown>;
                const defaults = DeviceDefaults.safeParse({
                    siteId: c.env.CMS_SITE_ID,
                    scopeId: c.env.CMS_SCOPE_ID,
                    qrBaseUrl: c.env.CMS_QR_BASE_URL ?? "",
                });
                const allowed =
                    defaults.success &&
                    Array.isArray(data.sites) &&
                    data.sites.includes(defaults.data.siteId) &&
                    Array.isArray(data.scopes) &&
                    data.scopes.includes(defaults.data.scopeId);
                return c.json(
                    {
                        ...data,
                        actorId: c.env.CMS_ACTOR_ID,
                        policyEditable: !!c.env.CMS_POLICY_SERVICE_TOKEN,
                        deviceDefaults: allowed && defaults.success ? defaults.data : null,
                    },
                    { headers: { "cache-control": "no-store" } }
                );
            }
            const out = new Headers({ "cache-control": "no-store" });
            for (const name of ["content-type", "x-request-id", "idempotency-replayed"]) {
                const v = response.headers.get(name);
                if (v) out.set(name, v);
            }
            return new Response(response.body, { status: response.status, headers: out });
        } catch {
            return fail(503, "STORAGE_UNAVAILABLE");
        }
    });
    app.get("*", async (c) =>
        c.env.ASSETS
            ? await c.env.ASSETS.fetch(c.req.raw)
            : c.json(
                  {
                      error: {
                          code: "NOT_FOUND",
                          message: "Not found",
                          requestId: crypto.randomUUID(),
                      },
                  },
                  404
              )
    );
    return app;
}
export default createBridge();
