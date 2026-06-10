/**
 * Full-mesh topology diagram. Nodes are placed on an ellipse; every pair is
 * linked (iBGP full mesh) with an amber "packet" running along each link.
 */
export function Topology({ nodes = [], ourAsn }) {
  const W = 640, H = 430, cx = W / 2, cy = H / 2 + 6, rx = 235, ry = 150;
  const n = Math.max(nodes.length, 1);
  const pos = nodes.map((node, i) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return { node, x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });
  const links = [];
  for (let i = 0; i < pos.length; i++) {
    for (let j = i + 1; j < pos.length; j++) links.push([pos[i], pos[j]]);
  }
  return (
    <svg className="topo-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="network topology">
      {links.map(([a, b], i) => (
        <g key={i}>
          <line className="topo-link" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
          <line
            className="topo-flow"
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            style={{ animationDelay: `${(i * 0.55) % 3.2}s` }}
          />
        </g>
      ))}
      <g className="topo-center">
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize="11">WIREGUARD + iBGP</text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize="11">FULL MESH</text>
        {ourAsn && <text x={cx} y={cy + 36} textAnchor="middle" fontSize="10" fill="#ffb000">AS{ourAsn}</text>}
      </g>
      {pos.map(({ node, x, y }) => (
        <g key={node.id} className="topo-chip" transform={`translate(${x - 62}, ${y - 25})`}>
          <rect width="124" height="50" rx="3" />
          <circle cx="16" cy="25" r="4" fill="#3ddc84">
            <animate attributeName="opacity" values="1;0.5;1" dur="2.4s" repeatCount="indefinite" />
          </circle>
          <text x="30" y="22" fontSize="13" fontWeight="700" style={{ textTransform: 'uppercase' }}>{node.id}</text>
          <text x="30" y="38" fontSize="9" fill="#8a94a3">{node.name}</text>
        </g>
      ))}
    </svg>
  );
}
