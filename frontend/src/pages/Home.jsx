import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Topology } from '../components/Topology.jsx';
import { NodeCard } from '../components/NodeCard.jsx';

function BootConsole({ info, nodes }) {
  const lines = [
    ['00.012', 'chassis power good'],
    ['00.180', `BIRD 2.x routing daemon · AS${info?.ourAsn || '424242xxxx'}`],
    ['00.421', `wireguard mesh: ${nodes.length || 4}/${nodes.length || 4} tunnels up`],
    ['00.633', `iBGP full mesh: ${nodes.length ? nodes.length * (nodes.length - 1) : 12} sessions ESTABLISHED`],
    ['00.910', `peering desk: ${info?.sessions?.active ?? 0} external sessions active`],
    ['01.002', 'accepting peering requests'],
  ];
  return (
    <div className="panel screws">
      <div className="panel-head">
        <span className="led grn" /> system console — backbone
      </div>
      <div className="panel-body boot">
        {lines.map(([t, msg], i) => (
          <div key={i} className="boot-line" style={{ animationDelay: `${0.4 + i * 0.35}s` }}>
            <span className="t">[{t}]</span>
            <span className="ok">OK</span>
            <span className="mono-cut">{msg}</span>
          </div>
        ))}
        <div className="boot-line cursor" style={{ animationDelay: `${0.4 + lines.length * 0.35}s` }}>
          <span className="t">[--.---]</span>
          <span className="amber">READY</span>
        </div>
      </div>
    </div>
  );
}

export function Home({ info }) {
  const [nodes, setNodes] = useState([]);
  useEffect(() => {
    api.nodes().then(setNodes).catch(() => {});
  }, []);

  return (
    <div className="page">
      <section className="hero">
        <div className="rise">
          <div className="sec-label">Self-service DN42 peering</div>
          <h1>
            Open<br />
            <span className="row2">Peering</span><br />
            Desk
          </h1>
          <p className="lede">
            {nodes.length || 4} backbone nodes, one WireGuard + iBGP full mesh. Verify your ASN
            against the DN42 registry, pick the closest node, and your BGP session is live
            in minutes — no tickets, no waiting for a human.
          </p>
          <div className="hero-cta">
            <Link to="/peer" className="btn solid">Start peering →</Link>
            <a href="#nodes" className="btn ghost">View nodes</a>
          </div>
        </div>
        <div className="rise" style={{ animationDelay: '0.15s' }}>
          <BootConsole info={info} nodes={nodes} />
        </div>
      </section>

      <div className="stats rise" style={{ animationDelay: '0.25s' }}>
        <div className="stat"><div className="v">{String(nodes.length || 4).padStart(2, '0')}</div><div className="k">Backbone nodes</div></div>
        <div className="stat"><div className="v">{String(info?.sessions?.active ?? 0).padStart(2, '0')}</div><div className="k">Active sessions</div></div>
        <div className="stat"><div className="v">{String(info?.sessions?.pending ?? 0).padStart(2, '0')}</div><div className="k">Pending requests</div></div>
        <div className="stat"><div className="v">{info?.autoApprove ? 'AUTO' : 'MANUAL'}</div><div className="k">Approval mode</div></div>
      </div>

      <section className="section">
        <div className="sec-label">01 · Backbone</div>
        <h2 className="sec-title">The mesh you are joining</h2>
        <div className="panel screws" style={{ padding: '10px 0' }}>
          <Topology nodes={nodes} ourAsn={info?.ourAsn} />
        </div>
      </section>

      <section className="section" id="nodes">
        <div className="sec-label">02 · Nodes</div>
        <h2 className="sec-title">Pick your closest faceplate</h2>
        <div className="node-grid">
          {nodes.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              footer={<Link to={`/peer?node=${n.id}`}>peer here →</Link>}
            />
          ))}
        </div>
      </section>

      <section className="section">
        <div className="sec-label">03 · Procedure</div>
        <h2 className="sec-title">Three steps to ESTABLISHED</h2>
        <div className="steps3">
          <div className="panel screws step3">
            <div className="n">01</div>
            <h3>Verify your ASN</h3>
            <p>
              Enter your DN42 ASN. We read your maintainer object from the registry and you
              prove ownership by signing a one-time challenge with your registry SSH or PGP key.
            </p>
          </div>
          <div className="panel screws step3">
            <div className="n">02</div>
            <h3>Configure the tunnel</h3>
            <p>
              Choose a node, paste your WireGuard public key and tunnel addresses.
              MP-BGP and extended next hop supported. We assign the port automatically.
            </p>
          </div>
          <div className="panel screws step3">
            <div className="n">03</div>
            <h3>Session goes live</h3>
            <p>
              The node provisions WireGuard + BIRD on the spot and hands you a ready-to-paste
              config for your side. Watch the session turn green on your dashboard.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="sec-label">04 · Policy</div>
        <h2 className="sec-title">Peering policy</h2>
        <div className="panel screws panel-body">
          <ul className="policy-list">
            <li>Open peering policy — any registered DN42 ASN is welcome on any node.</li>
            <li>Your ASN, route / route6 objects must exist in the DN42 registry with valid ROA.</li>
            <li>Link-local iBGP-style addressing preferred; MP-BGP over IPv6 link-local with extended next hop is the default.</li>
            <li>Sessions are filtered with standard DN42 ROA filters; invalid announcements are dropped.</li>
            <li>Tunnels idle for a long period or flapping persistently may be disabled — re-enable any time from your dashboard.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
