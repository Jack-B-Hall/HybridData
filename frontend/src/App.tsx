import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { ChatPage } from "@/pages/ChatPage";
import { DocumentsPage } from "@/pages/DocumentsPage";
import { ExplorerLayout } from "@/pages/explorer/ExplorerLayout";
import { ExplorerGraphTab } from "@/pages/explorer/ExplorerGraphTab";
import { ExplorerTableTab } from "@/pages/explorer/ExplorerTableTab";
import { ExplorerAnalyticsTab } from "@/pages/explorer/ExplorerAnalyticsTab";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<ChatPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/documents/:id" element={<DocumentsPage />} />
        <Route path="/explorer" element={<ExplorerLayout />}>
          <Route index element={<Navigate to="graph" replace />} />
          <Route path="graph" element={<ExplorerGraphTab />} />
          <Route path="table" element={<ExplorerTableTab />} />
          <Route path="analytics" element={<ExplorerAnalyticsTab />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
