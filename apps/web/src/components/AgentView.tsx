import { formatAgo } from '@inklog/core';
import { useEffect, useState } from 'react';
import { type AgentView as AgentViewData, api } from '../api';
import { useApp } from '../store';

/** What an AI agent sees: the map of every section, this section as `read` returns it, and the tools. */
export function AgentView({ section }: { section: string }) {
  const info = useApp((state) => state.info);
  const [data, setData] = useState<AgentViewData>();
  useEffect(() => {
    let current = true;
    void api.agentView(section).then((loaded) => current && setData(loaded));
    return () => {
      current = false;
    };
  }, [section, info]);

  if (!data) return <p className="notice muted">Loading…</p>;
  const tokens = (text: string) => Math.ceil(text.length / 4);
  return (
    <section className="agent-view" aria-label="AI view">
      <RemoteAccess />
      <p className="muted">This is the text an AI agent gets from Quillipi's tools. It is generated from your files, so it is always current.</p>
      <h3>map · about {tokens(data.map)} tokens</h3>
      <pre>{data.map}</pre>
      <h3>read("{section}") · about {tokens(data.read)} tokens</h3>
      <pre>{data.read}</pre>
      <h3>Tools</h3>
      <dl className="tool-list">
        {data.tools.map((tool) => (
          <div key={tool.name}>
            <dt>
              {tool.name} <span className="muted">about {tool.tokens} tokens</span>
            </dt>
            <dd>{tool.description}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Who can use this notebook from the cloud, and the address to give Claude. */
function RemoteAccess() {
  const remote = useApp((state) => state.info?.remote);
  const [copied, setCopied] = useState(false);
  if (!remote) {
    return (
      <p className="muted">
        Remote access is off. To use this notebook from claude.ai and the Claude apps, start Quillipi with --public-url. The README explains how.
      </p>
    );
  }
  const copy = async () => {
    await navigator.clipboard.writeText(remote.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const now = Date.now();
  return (
    <div className="remote-access">
      <h3>Remote access</h3>
      <p>In Claude, add this address under Settings, Connectors, Add custom connector:</p>
      <div className="copy-row">
        <code>{remote.url}</code>
        <button type="button" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {remote.connections.length ? (
        <ul className="connections" aria-label="Connected apps">
          {remote.connections.map((connection) => (
            <li key={connection.id}>
              <strong>{connection.app}</strong>
              <span className="muted">
                connected {formatAgo(connection.since, now)}, last used {formatAgo(connection.lastUsed, now)}
              </span>
              <button type="button" onClick={() => void api.disconnectRemote(connection.id)}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No apps are connected yet.</p>
      )}
    </div>
  );
}
