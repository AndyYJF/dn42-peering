import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, setToken } from '../api.js';
import { NodeCard } from '../components/NodeCard.jsx';
import { CopyBlock, Field, Spinner, StatusTag } from '../components/ui.jsx';

const STEPS = ['Identity', 'Node', 'Tunnel', 'Review'];

function Stepper({ step }) {
  return (
    <div className="stepper">
      {STEPS.map((label, i) => (
        <div key={label} className={`st${i === step ? ' active' : ''}${i < step ? ' done' : ''}`}>
          <span className="n">{i < step ? '✓' : String(i + 1).padStart(2, '0')}</span>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- step 1: registry identity ---------------- */

function StepAuth({ auth, onAuthed, onNext }) {
  const [asn, setAsn] = useState('');
  const [lookup, setLookup] = useState(null);
  const [method, setMethod] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [signature, setSignature] = useState('');
  const [pubKey, setPubKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (auth) {
    return (
      <div className="panel screws panel-body">
        <div className="alert ok">
          Authenticated as <b>AS{auth.asn}</b> ({auth.mntner}). Your session is valid — continue to node selection.
        </div>
        <button className="btn solid" onClick={onNext}>Continue →</button>
      </div>
    );
  }

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const doLookup = () => run(async () => {
    setChallenge(null);
    setMethod(null);
    setLookup(await api.lookup(asn));
  });

  const doChallenge = () => run(async () => {
    setSignature('');
    setChallenge(await api.challenge(lookup.asn, method));
  });

  const doVerify = () => run(async () => {
    const res = await api.verify(challenge.challengeId, signature, pubKey.trim() || undefined);
    setToken(res.token);
    onAuthed();
    onNext();
  });

  return (
    <div className="wizard-grid">
      <div className="panel screws panel-body">
        <Field label="Your DN42 ASN" hint="e.g. 4242421234">
          <input
            type="text"
            value={asn}
            placeholder="AS4242421234"
            onChange={(e) => setAsn(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doLookup()}
          />
        </Field>
        <button className="btn" onClick={doLookup} disabled={busy || !asn.trim()}>
          {busy && !lookup ? <Spinner /> : 'Query registry'}
        </button>

        {lookup && (
          <>
            <div className="divider-label">Registry record</div>
            <table className="kv">
              <tbody>
                <tr><td>AS name</td><td>{lookup.asName}</td></tr>
                <tr><td>Maintained by</td><td>{lookup.mntBy.join(', ')}</td></tr>
              </tbody>
            </table>

            <div className="divider-label">Prove ownership with</div>
            {lookup.methods.length === 0 && (
              <div className="alert">
                No usable auth method (SSH key, PGP fingerprint or contact e-mail) found in the registry.
                Add one to your MNTNER / person object, or contact us out-of-band.
              </div>
            )}
            {lookup.methods.map((m) => (
              <label key={m.idx} className={`method${method === m.idx ? ' selected' : ''}`}>
                <input
                  type="radio"
                  name="method"
                  checked={method === m.idx}
                  onChange={() => {
                    setMethod(m.idx);
                    setChallenge(null); // collapse any previous challenge UI
                    setSignature('');
                    setError('');
                  }}
                />
                <span className="chip">{m.type === 'pgp' ? 'PGP' : m.type === 'email' ? 'MAIL' : 'SSH'}</span>
                <span className="mono-cut" title={m.display}>{m.display}</span>
                <span className="dim xs" style={{ marginLeft: 'auto' }}>{m.mntner}</span>
              </label>
            ))}
            {lookup.methods.length > 0 && (
              <button className="btn" onClick={doChallenge} disabled={busy || method == null} style={{ marginTop: 10 }}>
                {busy && method != null && !challenge
                  ? <Spinner />
                  : lookup.methods[method]?.type === 'email'
                    ? (challenge?.method === 'email' ? 'Resend code' : 'Send code')
                    : (challenge && challenge.method !== 'email' ? 'New challenge' : 'Generate challenge')}
              </button>
            )}
          </>
        )}

        {challenge && challenge.method === 'email' && (
          <>
            <div className="divider-label">Enter the code</div>
            <div className="alert ok">
              A 6-digit code was sent to <b>{challenge.sentTo}</b> (from your registry contact).
              It is valid for {Math.round(challenge.ttlSec / 60)} minutes.
            </div>
            <Field label="Verification code" hint="6 digits">
              <input
                type="text"
                value={signature}
                onChange={(e) => setSignature(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => e.key === 'Enter' && signature.length === 6 && doVerify()}
                placeholder="000000"
                style={{ letterSpacing: '0.5em', fontSize: 18, maxWidth: 220 }}
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </Field>
            <button className="btn solid" onClick={doVerify} disabled={busy || signature.length !== 6}>
              {busy ? <Spinner /> : 'Verify & continue →'}
            </button>
          </>
        )}

        {challenge && challenge.method !== 'email' && (
          <>
            <div className="divider-label">Sign this challenge</div>
            <CopyBlock label="run on your machine" text={challenge.command} />
            <Field label="Paste the signature output" hint={challenge.method === 'pgp' ? 'full clearsigned block' : 'SSH SIGNATURE block'}>
              <textarea
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                placeholder={challenge.method === 'pgp' ? '-----BEGIN PGP SIGNED MESSAGE-----…' : '-----BEGIN SSH SIGNATURE-----…'}
              />
            </Field>
            {challenge.method === 'pgp' && (
              <Field label="Your public key" hint="optional — only if your key is not on a keyserver">
                <textarea
                  value={pubKey}
                  onChange={(e) => setPubKey(e.target.value)}
                  style={{ minHeight: 80 }}
                  placeholder={'gpg --armor --export <fingerprint>\n-----BEGIN PGP PUBLIC KEY BLOCK-----…'}
                />
              </Field>
            )}
            <button className="btn solid" onClick={doVerify} disabled={busy || !signature.trim()}>
              {busy ? <Spinner /> : 'Verify & continue →'}
            </button>
          </>
        )}

        {error && <div className="alert">{error}</div>}
      </div>

      <div className="panel screws">
        <div className="panel-head"><span className="led amber" /> how identity works</div>
        <div className="panel-body small mut">
          <p style={{ marginTop: 0 }}>
            We never ask for passwords. Ownership of your ASN is proven the same way the
            DN42 registry does it — with the keys already attached to your <b>MNTNER</b> object.
          </p>
          <p>
            <span className="amber">SSH:</span> sign the challenge with{' '}
            <code>ssh-keygen -Y sign</code> using the key listed in your registry <code>auth:</code> line.
          </p>
          <p>
            <span className="amber">PGP:</span> clearsign the challenge with the key matching your
            registered fingerprint. We fetch the public key from a keyserver.
          </p>
          <p>
            <span className="amber">E-mail:</span> a one-time code goes to the contact address
            on your registry person object (admin-c / tech-c).
          </p>
          <p style={{ marginBottom: 0 }}>
            The resulting session token lives in your browser only and expires after 24 hours.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ---------------- step 2: node ---------------- */

function StepNode({ nodes, existing, value, onChange, onNext, onBack }) {
  const taken = new Set(existing.map((p) => p.nodeId));
  return (
    <div>
      <div className="node-grid">
        {nodes.map((n) => {
          const has = taken.has(n.id);
          return (
            <NodeCard
              key={n.id}
              node={n}
              selectable={!has}
              selected={value === n.id}
              onSelect={() => onChange(n.id)}
              footer={has
                ? <span className="dim">already peered</span>
                : <span className={value === n.id ? 'amber' : 'dim'}>{value === n.id ? 'selected ✓' : 'select'}</span>}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
        <button className="btn ghost" onClick={onBack}>← Back</button>
        <button className="btn solid" onClick={onNext} disabled={!value}>Continue →</button>
      </div>
    </div>
  );
}

/* ---------------- step 3: tunnel ---------------- */

function StepTunnel({ auth, node, form, setForm, onNext, onBack }) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const suggestion = `fe80::${String(auth?.asn || '').slice(-4)}`;
  const valid = form.wgPubkey.trim().length >= 44 && form.peerLl.trim().startsWith('fe80:');
  return (
    <div className="wizard-grid">
      <div className="panel screws panel-body">
        <Field label="Your WireGuard public key" hint="44-char base64">
          <input type="text" value={form.wgPubkey} onChange={set('wgPubkey')} placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=" />
        </Field>
        <Field label="Your clearnet endpoint" hint="optional — leave empty if behind NAT">
          <input type="text" value={form.wgEndpoint} onChange={set('wgEndpoint')} placeholder="your.host.example.com:51820" />
        </Field>
        <Field label="Your tunnel link-local address" hint="fe80::/64">
          <input type="text" value={form.peerLl} onChange={set('peerLl')} placeholder={suggestion} />
        </Field>
        {!form.peerLl && (
          <p className="xs dim" style={{ marginTop: -10 }}>
            suggestion: <a onClick={() => setForm({ ...form, peerLl: suggestion })} style={{ cursor: 'pointer' }}>{suggestion}</a>
          </p>
        )}
        <Field label="Your DN42 IPv4" hint="optional — for a v4 point-to-point">
          <input type="text" value={form.peerV4} onChange={set('peerV4')} placeholder="172.2x.x.x" />
        </Field>
        <Field label="Your DN42 IPv6 (ULA)" hint="optional">
          <input type="text" value={form.peerV6} onChange={set('peerV6')} placeholder="fdxx:xxxx::x" />
        </Field>
        <div style={{ display: 'grid', gap: 10, margin: '20px 0' }}>
          <label className="check">
            <input type="checkbox" checked={form.mpBgp} onChange={set('mpBgp')} />
            MP-BGP — carry IPv4 + IPv6 over one session (recommended)
          </label>
          <label className="check">
            <input type="checkbox" checked={form.enh} onChange={set('enh')} />
            Extended next hop — IPv4 routes with IPv6 next hop, no v4 addressing needed
          </label>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn ghost" onClick={onBack}>← Back</button>
          <button className="btn solid" onClick={onNext} disabled={!valid}>Review →</button>
        </div>
      </div>

      <div className="panel screws">
        <div className="panel-head"><span className="led grn" /> our side · {node?.id}</div>
        <div className="panel-body">
          <table className="kv">
            <tbody>
              <tr><td>Endpoint</td><td>{node?.endpoint}:2xxxx <span className="dim xs">(port assigned on submit)</span></td></tr>
              <tr><td>Public key</td><td>{node?.wgPubkey}</td></tr>
              <tr><td>Link-local</td><td>{node?.linkLocal}</td></tr>
              {node?.tunnelV4 && <tr><td>DN42 v4</td><td>{node.tunnelV4}</td></tr>}
              {node?.dn42V6 && <tr><td>DN42 v6</td><td>{node.dn42V6}</td></tr>}
            </tbody>
          </table>
          <p className="xs dim" style={{ marginBottom: 0 }}>
            Port convention: <span className="amber">2xxxx</span> where xxxx are the last four
            digits of <b>your</b> ASN. You will get the exact endpoint after submitting.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ---------------- step 4: review + result ---------------- */

function theirWgConf(result) {
  const o = result.ourSide;
  const lines = [
    '[Interface]',
    'PrivateKey = <your-private-key>',
    `ListenPort = ${result.wgEndpoint ? result.wgEndpoint.split(':').pop() : 51820}`,
    'Table = off',
    `PostUp = ip addr add ${result.peerLl}/64 dev %i`,
    ...(result.peerV4 && o.tunnelV4 ? [`PostUp = ip addr add ${result.peerV4} peer ${o.tunnelV4}/32 dev %i`] : []),
    '',
    '[Peer]',
    `PublicKey = ${o.wgPubkey}`,
    `Endpoint = ${o.endpoint}`,
    'AllowedIPs = 10.0.0.0/8, 172.20.0.0/14, 172.31.0.0/16, fd00::/8, fe80::/64',
    'PersistentKeepalive = 25',
  ];
  return lines.join('\n');
}

function theirBirdConf(result, info) {
  const o = result.ourSide;
  return [
    `protocol bgp peeringdesk_${String(o.asn).slice(-4)} {`,
    `    local as ${result.asn};`,
    `    neighbor ${o.linkLocal} % 'dn42-yourside' as ${o.asn};`,
    '    path metric 1;',
    '    ipv4 {',
    '        import filter dn42_import;',
    '        export filter dn42_export;',
    ...(result.enh ? ['        extended next hop on;'] : []),
    '    };',
    '    ipv6 {',
    '        import filter dn42_import;',
    '        export filter dn42_export;',
    '    };',
    '}',
  ].join('\n');
}

function StepReview({ auth, node, form, onBack, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.createPeering({
        nodeId: node.id,
        wgPubkey: form.wgPubkey.trim(),
        wgEndpoint: form.wgEndpoint.trim() || undefined,
        peerLl: form.peerLl.trim(),
        peerV4: form.peerV4.trim() || undefined,
        peerV6: form.peerV6.trim() || undefined,
        mpBgp: form.mpBgp,
        enh: form.enh,
      });
      onDone(res);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="panel screws panel-body" style={{ maxWidth: 720 }}>
      <table className="kv">
        <tbody>
          <tr><td>Peer</td><td>AS{auth?.asn} ({auth?.mntner})</td></tr>
          <tr><td>Node</td><td>{node?.id} — {node?.name}</td></tr>
          <tr><td>WG public key</td><td>{form.wgPubkey}</td></tr>
          <tr><td>Endpoint</td><td>{form.wgEndpoint || <span className="dim">none (behind NAT — we listen, you dial)</span>}</td></tr>
          <tr><td>Link-local</td><td>{form.peerLl}</td></tr>
          {form.peerV4 && <tr><td>DN42 v4</td><td>{form.peerV4}</td></tr>}
          {form.peerV6 && <tr><td>DN42 v6</td><td>{form.peerV6}</td></tr>}
          <tr><td>Options</td><td>{[form.mpBgp && 'MP-BGP', form.enh && 'extended next hop'].filter(Boolean).join(' · ') || 'plain'}</td></tr>
        </tbody>
      </table>
      {error && <div className="alert">{error}</div>}
      <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
        <button className="btn ghost" onClick={onBack} disabled={busy}>← Back</button>
        <button className="btn solid" onClick={submit} disabled={busy}>
          {busy ? <><Spinner /> provisioning…</> : 'Provision session ⚡'}
        </button>
      </div>
    </div>
  );
}

function Done({ result, info }) {
  return (
    <div>
      <div className="panel screws panel-body" style={{ marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <h2 className="display" style={{ fontSize: 30 }}>
            {result.status === 'active' ? 'Session provisioned' : result.status === 'pending' ? 'Request submitted' : 'Submitted with errors'}
          </h2>
          <StatusTag status={result.status} />
        </div>
        {result.status === 'pending' && (
          <p className="mut small">An operator will approve your request shortly — check your dashboard later.</p>
        )}
        {result.status === 'error' && (
          <div className="alert">{result.lastError || 'deployment failed — an operator will look into it'}</div>
        )}
      </div>

      <div className="wizard-grid">
        <div>
          <div className="sec-label">Configure your side</div>
          <CopyBlock label={`wireguard · ${result.ourSide.iface}.conf`} text={theirWgConf(result)} />
          <CopyBlock label="bird2 · peer protocol" text={theirBirdConf(result, info)} />
        </div>
        <div className="panel screws">
          <div className="panel-head"><span className="led grn" /> our side — keep this</div>
          <div className="panel-body">
            <table className="kv">
              <tbody>
                <tr><td>ASN</td><td>AS{result.ourSide.asn}</td></tr>
                <tr><td>Endpoint</td><td>{result.ourSide.endpoint}</td></tr>
                <tr><td>Public key</td><td>{result.ourSide.wgPubkey}</td></tr>
                <tr><td>Link-local</td><td>{result.ourSide.linkLocal}</td></tr>
                {result.ourSide.tunnelV4 && <tr><td>DN42 v4</td><td>{result.ourSide.tunnelV4}</td></tr>}
                {result.ourSide.dn42V6 && <tr><td>DN42 v6</td><td>{result.ourSide.dn42V6}</td></tr>}
              </tbody>
            </table>
            <Link to="/dashboard" className="btn solid" style={{ display: 'inline-block', marginTop: 16 }}>
              Go to dashboard →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- wizard shell ---------------- */

export function Wizard({ info, auth, onAuthed }) {
  const [params] = useSearchParams();
  const [step, setStep] = useState(auth ? 1 : 0);
  const [nodes, setNodes] = useState([]);
  const [existing, setExisting] = useState([]);
  const [nodeId, setNodeId] = useState(params.get('node') || '');
  const [form, setForm] = useState({ wgPubkey: '', wgEndpoint: '', peerLl: '', peerV4: '', peerV6: '', mpBgp: true, enh: true });
  const [result, setResult] = useState(null);

  useEffect(() => {
    api.nodes().then(setNodes).catch(() => {});
  }, []);
  useEffect(() => {
    if (auth) api.myPeerings().then(setExisting).catch(() => {});
  }, [auth, step]);

  const node = useMemo(() => nodes.find((n) => n.id === nodeId), [nodes, nodeId]);

  return (
    <div className="page">
      <div className="page-head">
        <div className="sec-label">Peering wizard</div>
        <h1 className="sec-title" style={{ marginBottom: 0 }}>
          {result ? 'Hand-off' : 'Establish a session'}
        </h1>
      </div>

      {!result && <Stepper step={step} />}

      {result ? (
        <Done result={result} info={info} />
      ) : step === 0 ? (
        <StepAuth auth={auth} onAuthed={onAuthed} onNext={() => setStep(1)} />
      ) : step === 1 ? (
        <StepNode nodes={nodes} existing={existing} value={nodeId} onChange={setNodeId} onNext={() => setStep(2)} onBack={() => setStep(0)} />
      ) : step === 2 ? (
        <StepTunnel auth={auth} node={node} form={form} setForm={setForm} onNext={() => setStep(3)} onBack={() => setStep(1)} />
      ) : (
        <StepReview auth={auth} node={node} form={form} onBack={() => setStep(2)} onDone={setResult} />
      )}
    </div>
  );
}
