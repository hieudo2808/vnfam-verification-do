import { OpenAPIHono, z } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import { bodyLimit } from "hono/body-limit";
import { ApiError, type AppEnv } from "./platform";
import { registryRoutes } from "./routes/registry";
import { checkInRoutes } from "./routes/checkins";
import { checkinVerificationRoutes } from "./routes/checkin-verification";
import { deviceRoutes } from "./routes/devices";
import { firmwareRoutes } from "./routes/firmware";
import { cmsRoutes } from "./routes/cms";
import { runtimeSettingsRoutes } from "./routes/runtime-settings";
import { registrationRoutes } from "./routes/registrations";

export { DeviceDO } from "./durable-objects/device";

const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
        if (!result.success) throw new ApiError(422, "VALIDATION_ERROR");
    },
});

app.use(requestId({ limitLength: 0, generator: () => crypto.randomUUID() }));
app.use("/api/*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (/\/firmware-releases\/[^/]+\/binary$/.test(c.req.path) && c.req.method === "PUT")
        return next();
    return bodyLimit({
        maxSize: 65536,
        onError: () => {
            throw new ApiError(413, "PAYLOAD_TOO_LARGE");
        },
    })(c, next);
});
app.openAPIRegistry.registerComponent("securitySchemes", "ServiceBearer", {
    type: "http",
    scheme: "bearer",
});
app.openAPIRegistry.registerComponent("securitySchemes", "DeviceBearer", {
    type: "http",
    scheme: "bearer",
});
registryRoutes(app);
cmsRoutes(app);
checkInRoutes(app);
checkinVerificationRoutes(app);
deviceRoutes(app);
firmwareRoutes(app);
runtimeSettingsRoutes(app);
registrationRoutes(app);
app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "VNFAM Device API", version: "1.0.0" },
});

app.openAPIRegistry.registerPath({
    method: "get",
    path: "/health",
    responses: {
        200: {
            description: "Service liveness",
            content: {
                "application/json": {
                    schema: z.object({
                        status: z.literal("ok"),
                        service: z.literal("vnfam-device-api"),
                    }),
                },
            },
        },
    },
});
app.get("/health", (c) => c.json({ status: "ok", service: "vnfam-device-api" }));

app.notFound((c) =>
    c.json(
        {
            error: {
                code: "NOT_FOUND",
                message: "Endpoint not found",
                requestId: c.get("requestId"),
            },
        },
        404
    )
);

app.onError((e, c) => {
    const requestId = c.get("requestId");
    const error =
        e instanceof ApiError
            ? e
            : e instanceof SyntaxError
              ? new ApiError(422, "VALIDATION_ERROR")
              : /D1|SQLITE|R2|storage/i.test(String(e))
                ? new ApiError(503, "STORAGE_UNAVAILABLE")
                : null;
    if (!error) console.error(JSON.stringify({ event: "request.failed", requestId }));
    return c.json(
        {
            error: {
                code: error?.code ?? "INTERNAL_ERROR",
                message: error?.message ?? "Internal server error",
                requestId,
            },
        },
        error?.status ?? 500
    );
});

export default app;
