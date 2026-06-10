import { Led } from './ui.jsx';

export function NodeCard({ node, selectable, selected, onSelect, footer }) {
  return (
    <div
      className={`panel screws node-card${selectable ? ' selectable' : ''}${selected ? ' selected' : ''}`}
      onClick={selectable ? onSelect : undefined}
      role={selectable ? 'button' : undefined}
      tabIndex={selectable ? 0 : undefined}
      onKeyDown={selectable ? (e) => (e.key === 'Enter' || e.key === ' ') && onSelect() : undefined}
    >
      <div className="head">
        <Led color="grn" />
        <span className="id">{node.id}</span>
        <span className="chip cc">{node.cc}</span>
      </div>
      <div className="rows">
        <div className="row"><span className="k">Site</span><span className="v">{node.name}</span></div>
        <div className="row"><span className="k">Endpoint</span><span className="v" title={node.endpoint}>{node.endpoint}</span></div>
        <div className="row"><span className="k">Link-local</span><span className="v">{node.linkLocal}</span></div>
        {node.tunnelV4 && <div className="row"><span className="k">DN42 v4</span><span className="v">{node.tunnelV4}</span></div>}
      </div>
      <div className="feats">
        {(node.features || []).map((f) => <span key={f} className="chip">{f}</span>)}
      </div>
      <div className="foot">
        <span className="dim">{node.activeSessions ?? 0} sessions</span>
        {footer}
      </div>
    </div>
  );
}
