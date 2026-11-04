import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router";
import { DeviceAdminModule } from "./module";
const base = (import.meta.env.VITE_ADMIN_BASE_PATH ?? "").replace(/\/$/, "");
createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
        <Routes>
            <Route
                path={base + "/*"}
                element={
                    <DeviceAdminModule
                        basePath={base}
                        apiBaseUrl={import.meta.env.VITE_ADMIN_API_BASE_URL ?? "/cms-api"}
                    />
                }
            />
        </Routes>
    </BrowserRouter>
);
