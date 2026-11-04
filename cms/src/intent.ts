import { useRef } from "react";
export function useIntent() {
    const intent = useRef<ReturnType<typeof mutationIntent> | null>(null);
    if (!intent.current) intent.current = mutationIntent();
    return intent.current;
}
export function mutationIntent() {
    let current: { body: string; key: string } | null = null,
        busy = false;
    return {
        async run<T>(input: unknown, send: (key: string) => Promise<T>) {
            if (busy) throw new Error("MUTATION_IN_FLIGHT");
            const body = JSON.stringify(input);
            if (current?.body !== body) current = { body, key: crypto.randomUUID() };
            busy = true;
            try {
                const value = await send(current.key);
                current = null;
                return value;
            } finally {
                busy = false;
            }
        },
    };
}
