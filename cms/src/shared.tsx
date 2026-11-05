import {
    createContext,
    useContext,
    useEffect,
    useState,
    useRef,
    type ReactNode,
    type Dispatch,
    type SetStateAction,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import * as C from "../../src/cms-contracts";
import { Pairing } from "../../src/contracts";
import { Api, errorMessage, time } from "./client";
import { Button } from "./components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "./components/ui/dialog";
export const BridgeContext = C.Context.extend({
    actorId: z.string(),
    policyEditable: z.boolean(),
    deviceDefaults: C.DeviceDefaults.nullable().default(null),
});
export type PairingSecret = { pairing: z.infer<typeof Pairing>; expiresAtClientMs: number };
export const ModuleContext = createContext<{
    api: Api;
    portal: HTMLElement | null;
    pairingSecrets?: Record<string, PairingSecret>;
    setPairingSecrets?: Dispatch<SetStateAction<Record<string, PairingSecret>>>;
}>({
    api: new Api(),
    portal: null,
});
export const useModule = () => useContext(ModuleContext);
export function useVisible() {
    const [active, setActive] = useState(document.visibilityState !== "hidden" && navigator.onLine);
    useEffect(() => {
        const update = () => setActive(document.visibilityState !== "hidden" && navigator.onLine);
        document.addEventListener("visibilitychange", update);
        window.addEventListener("online", update);
        window.addEventListener("offline", update);
        return () => {
            document.removeEventListener("visibilitychange", update);
            window.removeEventListener("online", update);
            window.removeEventListener("offline", update);
        };
    }, []);
    return active;
}
export function useRead<T>(
    path: string,
    schema: z.ZodType<T>,
    interval: number | false = 15000,
    enabled = true
) {
    const { api } = useModule(),
        visible = useVisible();
    return useQuery({
        queryKey: [api.base, path],
        queryFn: ({ signal }) => api.call(path, "GET", undefined, schema, undefined, signal),
        enabled: visible && enabled,
        refetchInterval: visible && enabled ? interval : false,
        refetchIntervalInBackground: false,
        retry: false,
        refetchOnWindowFocus: true,
    });
}
export function useRefresh() {
    const q = useQueryClient();
    return () => q.invalidateQueries();
}
export function Problem({ error, retry }: { error: unknown; retry?: () => unknown }) {
    return (
        <div role="alert" className="problem">
            <p>{errorMessage(error)}</p>
            {retry && (
                <Button variant="outline" onClick={() => retry()}>
                    Thử lại
                </Button>
            )}
        </div>
    );
}
export function ReadState({
    query,
    children,
}: {
    query: { isPending: boolean; error: unknown; isFetching: boolean; refetch: () => unknown };
    children: ReactNode;
}) {
    return (
        <>
            {query.isPending ? <p role="status">Đang tải…</p> : children}
            {query.error && <Problem error={query.error} retry={query.refetch} />}
            <span className="sr-only" role="status">
                {query.isFetching ? "Đang cập nhật" : ""}
            </span>
        </>
    );
}
export function Field({
    label,
    error,
    children,
}: {
    label: string;
    error?: string;
    children: ReactNode;
}) {
    return (
        <label className="field">
            <span>{label}</span>
            {children}
            {!!error && (
                <span role="alert" className="field-error">
                    {error}
                </span>
            )}
        </label>
    );
}
export function Confirm({
    open,
    title,
    description,
    busy,
    confirmDisabled = false,
    children,
    onClose,
    onConfirm,
}: {
    open: boolean;
    title: string;
    description: string;
    busy: boolean;
    confirmDisabled?: boolean;
    children?: ReactNode;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const { portal } = useModule();
    const trigger = useRef<HTMLElement | null>(null);
    return (
        <Dialog
            open={open}
            onOpenChange={(v) => {
                if (!v && !busy) onClose();
            }}
        >
            <DialogContent
                container={portal}
                showCloseButton={!busy}
                onOpenAutoFocus={() => {
                    trigger.current =
                        document.activeElement instanceof HTMLElement
                            ? document.activeElement
                            : null;
                }}
                onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    trigger.current?.focus();
                }}
            >
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
                {children}
                <DialogFooter>
                    <Button variant="outline" disabled={busy} onClick={onClose}>
                        Đóng
                    </Button>
                    <Button disabled={busy || confirmDisabled} onClick={onConfirm}>
                        {busy ? "Đang gửi…" : "Xác nhận"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
export function PageButtons({
    next,
    previous,
    onNext,
    onPrevious,
}: {
    next: string | null;
    previous: boolean;
    onNext: () => void;
    onPrevious: () => void;
}) {
    return (
        <div className="pager">
            <Button variant="outline" disabled={!previous} onClick={onPrevious}>
                Trang trước
            </Button>
            <Button variant="outline" disabled={!next} onClick={onNext}>
                Trang sau
            </Button>
        </div>
    );
}
export function Stamp({ value }: { value: number | null }) {
    return (
        <time dateTime={value === null ? undefined : new Date(value).toISOString()}>
            {time(value)}
        </time>
    );
}
