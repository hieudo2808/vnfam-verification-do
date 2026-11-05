import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Routes, Route, NavLink, Navigate, Outlet, useParams } from "react-router";
import { Monitor, History, ClipboardCheck, Settings } from "lucide-react";
import { Api } from "./client";
import { ModuleContext, type ArtifactFile, type PairingSecret } from "./shared";
import { Devices, NewDevice, DeviceDetail } from "./devices";
import { Firmware, FirmwareDetail } from "./firmware";
import { HistoryTable, Policy } from "./history";
import { TimeSettingsPage } from "./runtime-settings";
import { DeviceRegistrations } from "./registrations";
import "./styles.css";
export interface DeviceAdminConfig {
    basePath?: string;
    apiBaseUrl?: string;
    theme?: CSSProperties;
}
export function DeviceAdminModule({
    basePath = "",
    apiBaseUrl = "/cms-api",
    theme,
}: DeviceAdminConfig) {
    const [client] = useState(
            () =>
                new QueryClient({
                    defaultOptions: {
                        queries: { retry: false, refetchOnWindowFocus: true },
                        mutations: { retry: false },
                    },
                })
        ),
        [portal, setPortal] = useState<HTMLDivElement | null>(null),
        [artifact, setArtifact] = useState<ArtifactFile | null>(null),
        [pairingSecrets, setPairingSecrets] = useState<Record<string, PairingSecret>>({}),
        api = useMemo(() => new Api(apiBaseUrl), [apiBaseUrl]);
    useEffect(() => {
        const expiry = Math.min(...Object.values(pairingSecrets).map((s) => s.expiresAtClientMs));
        if (!Number.isFinite(expiry)) return;
        const timer = setTimeout(
            () =>
                setPairingSecrets((current) =>
                    Object.fromEntries(
                        Object.entries(current).filter(([, s]) => s.expiresAtClientMs > Date.now())
                    )
                ),
            Math.max(0, expiry - Date.now())
        );
        return () => clearTimeout(timer);
    }, [pairingSecrets]);
    useEffect(() => {
        setPairingSecrets({});
    }, [api]);
    const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
    return (
        <QueryClientProvider client={client}>
            <ModuleContext.Provider
                value={{ api, portal, artifact, setArtifact, pairingSecrets, setPairingSecrets }}
            >
                <div className="vnfam-admin" style={theme}>
                    <header>
                        <span className="brand">
                            VNFAM <span>Thiết bị</span>
                        </span>
                    </header>
                    <div className="workspace">
                        <aside>
                            <nav aria-label="Quản trị thiết bị">
                                {[
                                    ["devices", "Thiết bị", Monitor],
                                    ["check-ins", "Check-in", ClipboardCheck],
                                    ["audit", "Nhật ký", History],
                                    ["settings", "Cài đặt chung", Settings],
                                ].map(([path, label, Icon]) => {
                                    const I = Icon as typeof Monitor;
                                    return (
                                        <NavLink key={String(path)} to={base + "/" + path}>
                                            <I size={18} aria-hidden="true" />
                                            {String(label)}
                                        </NavLink>
                                    );
                                })}
                            </nav>
                        </aside>
                        <main id="vnfam-content">
                            <Routes>
                                <Route path="devices" element={<Devices />} />
                                <Route path="devices/new" element={<NewDevice />} />
                                <Route
                                    path="devices/registrations"
                                    element={<DeviceRegistrations />}
                                />
                                <Route path="devices/:deviceId" element={<DeviceDetail />} />
                                <Route path="settings" element={<SettingsLayout />}>
                                    <Route index element={<Navigate to="firmware" replace />} />
                                    <Route path="firmware" element={<Firmware />} />
                                    <Route
                                        path="firmware/:releaseId"
                                        element={<FirmwareDetail />}
                                    />
                                    <Route path="policy" element={<Policy />} />
                                    <Route path="time" element={<TimeSettingsPage />} />
                                </Route>
                                <Route
                                    path="firmware"
                                    element={<Navigate to={base + "/settings/firmware"} replace />}
                                />
                                <Route
                                    path="firmware/:releaseId"
                                    element={<LegacyRelease base={base} />}
                                />
                                <Route
                                    path="check-ins"
                                    element={<HistoryTable kind="check-ins" />}
                                />
                                <Route
                                    path="audit"
                                    element={<HistoryTable kind="audit-events" />}
                                />
                                <Route
                                    path="policy"
                                    element={<Navigate to={base + "/settings/policy"} replace />}
                                />
                                <Route
                                    path="time"
                                    element={<Navigate to={base + "/settings/time"} replace />}
                                />
                                <Route
                                    path="*"
                                    element={<Navigate to={base + "/devices"} replace />}
                                />
                            </Routes>
                        </main>
                    </div>
                    <div ref={setPortal} />
                </div>
            </ModuleContext.Provider>
        </QueryClientProvider>
    );
}
function LegacyRelease({ base }: { base: string }) {
    const { releaseId } = useParams();
    return <Navigate to={base + "/settings/firmware/" + releaseId} replace />;
}
function SettingsLayout() {
    return (
        <>
            <nav aria-label="Cài đặt chung" className="settings-tabs">
                {[
                    ["firmware", "Firmware"],
                    ["policy", "Chính sách QR"],
                    ["time", "Thời gian"],
                ].map(([path, label]) => (
                    <NavLink key={path} to={path!}>
                        {label}
                    </NavLink>
                ))}
            </nav>
            <Outlet />
        </>
    );
}
