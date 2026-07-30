import { useState } from "react";
import { ResultRpcProvider } from "result-rpc/react";
import {
  BoundaryProvider,
  client,
  CmsShell,
  getCurrentUser,
  setCurrentUser,
  useConnectivity,
} from "./client.js";
import { MediaPage } from "./pages/MediaPage.js";
import { PostEditorPage } from "./pages/PostEditorPage.js";
import { PostListPage } from "./pages/PostListPage.js";
import { navigate, useRoute } from "./router.js";

export function App() {
  return (
    <ResultRpcProvider client={client}>
      <BoundaryProvider>
        <CmsShell.Provider>
          <Chrome />
        </CmsShell.Provider>
      </BoundaryProvider>
    </ResultRpcProvider>
  );
}

function Chrome() {
  const route = useRoute();
  return (
    <div className="app">
      <header className="app__bar">
        <strong className="app__brand">admin proof</strong>
        <nav className="app__nav">
          <button
            type="button"
            className={route.name === "posts" || route.name === "post" ? "is-active" : ""}
            onClick={() => navigate("/posts")}
          >
            Posts
          </button>
          <button
            type="button"
            className={route.name === "media" ? "is-active" : ""}
            onClick={() => navigate("/media")}
          >
            Media
          </button>
        </nav>
        <ConnectionBanner />
        <SessionSwitch />
      </header>

      <main className="app__body">
        {route.name === "posts" && <PostListPage />}
        {route.name === "post" && <PostEditorPage id={route.id} />}
        {route.name === "media" && <MediaPage />}
      </main>
    </div>
  );
}

function ConnectionBanner() {
  const net = useConnectivity();
  if (net.status === "online") return null;
  return (
    <span className="app__net" role="alert">
      {net.status === "offline" ? "offline" : `connection trouble (${net.held} held)`}
      {net.status === "degraded" && (
        <button type="button" onClick={net.resume}>
          retry
        </button>
      )}
    </span>
  );
}

/**
 * The dev auth switch. Signing out makes every mutation fail with the HOST's
 * `auth/unauthorized` — agent-cms contributes no auth tag of its own.
 */
function SessionSwitch() {
  const [user, setUser] = useState<string | null>(getCurrentUser());
  const choose = (next: string | null) => {
    setCurrentUser(next);
    setUser(next);
  };
  return (
    <label className="app__session">
      acting as
      <select value={user ?? ""} onChange={(event) => choose(event.target.value || null)}>
        <option value="ada">ada</option>
        <option value="grace">grace</option>
        <option value="">(signed out)</option>
      </select>
    </label>
  );
}
