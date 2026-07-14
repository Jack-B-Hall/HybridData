import { liveApi } from "./client";
import { mockApi } from "./mockClient";

export const useMocks = import.meta.env.VITE_USE_MOCKS === "1";

export const api = useMocks ? mockApi : liveApi;

export * from "./types";
export type { HdeApi } from "./client";
