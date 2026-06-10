import { useState } from 'react';

export function Led({ color = 'off', blink = false }) {
  return <span className={`led ${color}${blink ? ' blink' : ''}`} />;
}

const STATUS_MAP = {
  active: { color: 'grn', label: 'ACTIVE', blink: false },
  pending: { color: 'amber', label: 'PENDING APPROVAL', blink: true },
  deploying: { color: 'amber', label: 'DEPLOYING', blink: true },
  error: { color: 'red', label: 'ERROR', blink: false },
  disabled: { color: 'off', label: 'DISABLED', blink: false },
};

export function StatusTag({ status }) {
  const s = STATUS_MAP[status] || { color: 'off', label: status?.toUpperCase() || '—' };
  return (
    <span className={`tag ${s.color}`}>
      <Led color={s.color} blink={s.blink} />
      {s.label}
    </span>
  );
}

export function BgpStateTag({ state }) {
  const up = state === 'Established';
  return (
    <span className={`tag ${up ? 'grn' : 'amber'}`}>
      <Led color={up ? 'grn' : 'amber'} blink={!up} />
      {state?.toUpperCase() || 'UNKNOWN'}
    </span>
  );
}

export function CopyBlock({ label, text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable (http) — user can select manually */ }
  };
  return (
    <div className="copyblock">
      {label && <span className="copy-label">{label}</span>}
      <button type="button" onClick={copy}>{copied ? 'COPIED ✓' : 'COPY'}</button>
      <pre>{text}</pre>
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">
        <span>{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Spinner() {
  return <span className="spin" />;
}

export function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function fmtAge(sec) {
  if (sec == null) return 'never';
  if (sec < 90) return `${sec}s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}
