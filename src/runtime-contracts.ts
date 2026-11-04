import { z } from "@hono/zod-openapi";
import { Id, Time, TimeReport } from "./contracts";
export const TimeServer = z.union([z.hostname().max(253), z.ipv4(), z.ipv6()]);
export const Timezone = z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
        try {
            new Intl.DateTimeFormat("en", { timeZone: value });
            return true;
        } catch {
            return false;
        }
    }, "Invalid IANA timezone");
export const TimeSettingsInput = z.strictObject({
    revision: z.number().int().positive(),
    server: TimeServer,
    timezone: Timezone.optional(),
});
export const TimeSettings = TimeSettingsInput.extend({
    protocol: z.literal("SNTP"),
    timezone: Timezone,
});
export const NetworkInput = z.strictObject({
    revision: z.number().int().positive(),
    ssid: z
        .string()
        .min(1)
        .refine((v) => new TextEncoder().encode(v).byteLength <= 32),
    password: z
        .string()
        .refine(
            (v) =>
                v === "" ||
                (new TextEncoder().encode(v).byteLength >= 8 &&
                    new TextEncoder().encode(v).byteLength <= 63) ||
                /^[a-fA-F0-9]{64}$/.test(v)
        )
        .optional(),
});
export const NetworkConfig = z.strictObject({
    revision: z.number().int().positive(),
    appliedRevision: z.number().int().nonnegative(),
    ssid: z.string().nullable(),
    passwordConfigured: z.boolean(),
});
export const RuntimeStatus = z.strictObject({
    observedAt: Time,
    runtimeConfigVersion: z.literal(1).nullable(),
    wifiSsid: z.string().nullable(),
    time: TimeReport.nullable(),
});
export const RuntimeSettings = z.strictObject({
    network: NetworkConfig,
    status: RuntimeStatus.nullable(),
    time: TimeSettings,
});
export const NetworkDownloadQuery = z.strictObject({ operationId: Id });
export const NetworkDownload = z.strictObject({
    revision: z.number().int().positive(),
    ssid: z.string(),
    password: z.string(),
});
