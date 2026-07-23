import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { ChatPage } from "@/pages/ChatPage";
import { ConversationsPage } from "@/pages/ConversationsPage";
import { DocumentsPage } from "@/pages/DocumentsPage";
import { ExplorerLayout } from "@/pages/explorer/ExplorerLayout";
import { ExplorerGraphTab } from "@/pages/explorer/ExplorerGraphTab";
import { ExplorerTableTab } from "@/pages/explorer/ExplorerTableTab";
import { ExplorerAnalyticsTab } from "@/pages/explorer/ExplorerAnalyticsTab";
import { IngestionPage } from "@/pages/IngestionPage";
import { TestingPage } from "@/pages/TestingPage";
import { ChatProvider } from "@/store/chat";
import { DrawerProvider } from "@/store/drawer";
import { CorpusMetaProvider, useCorpusMeta } from "@/store/corpusMeta";
import { SourceDrawer } from "@/components/SourceDrawer";
import { TABS, firstEnabledPath, isTabEnabled, type TabKey } from "@/lib/tabs";

/**
 * Route guard for [ui.tabs]: a deep link into a disabled tab redirects to the
 * first enabled tab instead of rendering it. When EVERY tab is disabled (a
 * config mistake) the fallback path is this tab's own path for the Interface
 * route; redirecting to ourselves would render an endless self-navigation
 * loop, so render the tab instead.
 */
function TabRoute({ tab, children }: { tab: TabKey; children: React.ReactNode }) {
  const { tabs } = useCorpusMeta();
  if (!isTabEnabled(tabs, tab)) {
    const target = firstEnabledPath(tabs);
    const ownPath = TABS.find((t) => t.key === tab)?.path;
    if (target !== ownPath) return <Navigate to={target} replace />;
  }
  return <>{children}</>;
}

export function App() {
  // Providers live above the router so chat history and the source drawer
  // survive navigation between tabs (Chat ↔ Documents ↔ Data Explorer).
  return (
    <CorpusMetaProvider>
      <ChatProvider>
        <DrawerProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<TabRoute tab="interface"><ChatPage /></TabRoute>} />
            <Route path="/chat" element={<TabRoute tab="chat"><ConversationsPage /></TabRoute>} />
            <Route path="/documents" element={<TabRoute tab="documents"><DocumentsPage /></TabRoute>} />
            <Route path="/documents/:id" element={<TabRoute tab="documents"><DocumentsPage /></TabRoute>} />
            <Route path="/explorer" element={<TabRoute tab="explorer"><ExplorerLayout /></TabRoute>}>
              <Route index element={<Navigate to="graph" replace />} />
              <Route path="graph" element={<ExplorerGraphTab />} />
              <Route path="table" element={<ExplorerTableTab />} />
              <Route path="analytics" element={<ExplorerAnalyticsTab />} />
            </Route>
            <Route path="/ingestion" element={<TabRoute tab="ingestion"><IngestionPage /></TabRoute>} />
            <Route path="/testing" element={<TabRoute tab="testing"><TestingPage /></TabRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <SourceDrawer />
        </DrawerProvider>
      </ChatProvider>
    </CorpusMetaProvider>
  );
}
