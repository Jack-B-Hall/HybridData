import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { ChatPage } from "@/pages/ChatPage";
import { DocumentsPage } from "@/pages/DocumentsPage";
import { ExplorerLayout } from "@/pages/explorer/ExplorerLayout";
import { ExplorerGraphTab } from "@/pages/explorer/ExplorerGraphTab";
import { ExplorerTableTab } from "@/pages/explorer/ExplorerTableTab";
import { ExplorerAnalyticsTab } from "@/pages/explorer/ExplorerAnalyticsTab";
import { IngestionPage } from "@/pages/IngestionPage";
import { TestingPage } from "@/pages/TestingPage";
import { ChatProvider } from "@/store/chat";
import { DrawerProvider } from "@/store/drawer";
import { CorpusMetaProvider } from "@/store/corpusMeta";
import { SourceDrawer } from "@/components/SourceDrawer";

export function App() {
  // Providers live above the router so chat history and the source drawer
  // survive navigation between tabs (Chat ↔ Documents ↔ Data Explorer).
  return (
    <CorpusMetaProvider>
      <ChatProvider>
        <DrawerProvider>
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
            <Route path="/ingestion" element={<IngestionPage />} />
            <Route path="/testing" element={<TestingPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <SourceDrawer />
        </DrawerProvider>
      </ChatProvider>
    </CorpusMetaProvider>
  );
}
