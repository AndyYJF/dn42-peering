# Repository-managed DN42 core

This directory is the source of truth for the four-node internal routing core.
It follows the useful parts of `iYoRoy-Network/bird2-config`: data is reviewed
in Git, configs are rendered deterministically, CI validates the topology, and
live state is audited before and after any rollout.

## Ownership boundary

| Path on a node | Owner | Why |
|---|---|---|
| `/etc/bird/ospf.conf`, `/etc/bird/ospf/*` | this directory | OSPF topology and costs change through Git review |
| `/etc/bird/ibgp.conf`, `/etc/bird/ibgp/*` | this directory | the four-node iBGP full mesh changes through Git review |
| `/etc/bird/peers/*` | Auto Peer agent / existing manual config | dynamic peers must not be deleted by a core rollout |
| `/etc/wireguard/dn42-<full-asn>.conf` | Auto Peer agent | peer lifecycle remains transactional and database-backed |
| node private keys, API tokens, passwords | node-local secret files | secrets are forbidden in `inventory.json` |

The initial scope deliberately does not render `bird.conf` or WireGuard. This
keeps the existing ROA/filter policy and all dynamic sessions outside the first
repository-managed rollout.

## Files

- `inventory.json`: public node identities, mesh addresses, interface names,
  and current OSPF costs.
- `templates/`: BIRD OSPF/iBGP templates.
- `render.py`: dependency-free validation and deterministic rendering.
- `audit.py`: read-only SSH audit of OSPF Full/PtP and iBGP Established state.
- `.rendered/`: generated output; ignored by Git.

## Local workflow

Validate without leaving generated files:

```bash
python3 network/render.py --check
python3 -m unittest discover -s network -p 'test_*.py' -v
```

Render files for inspection:

```bash
python3 network/render.py
find network/.rendered -type f -maxdepth 4 -print
```

Audit live routing through an SSH key or ssh-agent (passwords are intentionally
unsupported):

```bash
python3 network/audit.py --identity deploy/.work/deploy_key
python3 network/audit.py --node tyo --identity deploy/.work/deploy_key
```

## Safe rollout sequence

The generated files are not deployed automatically yet. The first rollout must
be a canary and preserve the dynamic peer directory:

1. Render and review the node diff.
2. Capture `network/audit.py` as the pre-change baseline.
3. Copy only `ospf.conf`, `ospf/`, `ibgp.conf`, and `ibgp/` to a remote staging
   directory. Never use `rsync --delete` against all of `/etc/bird`.
4. Overlay those files onto a copy of `/etc/bird` and run `bird -p -c bird.conf`.
5. Back up the live managed files, promote them, and run `birdc configure`.
6. Require three Full/PtP neighbors in both OSPF families and three Established
   iBGP sessions. Restore the backup if the check fails.
7. Roll out HKT first, then TYO, FRA, and LAX one at a time.

The next phase adds the transactional deploy helper after the generated output
has been compared with all four live nodes.
