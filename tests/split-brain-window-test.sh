#!/usr/bin/env bash
# Throwaway proof for check-contract-split-brain.mjs during the cross-repo window.
set -uo pipefail
LINT="$(cd "$(dirname "${1:?path to check-contract-split-brain.mjs}")" && pwd)/$(basename "$1")"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "  ✓ $1"; }
no() { FAIL=$((FAIL+1)); echo "  ✗ $1"; printf '%s\n' "$2" | sed 's/^/      /'; }

# a store whose contract is still an ACTIVE change (never archived)
mkdir -p "$T/store/openspec/changes/add-payments/specs/payments-events-v2"
cat > "$T/store/openspec/changes/add-payments/specs/payments-events-v2/spec.md" <<'EOF'
## ADDED Requirements
### Requirement: Payment captured event
The system SHALL publish `payment.captured`.

#### Scenario: ok
- **WHEN** a payment is captured
- **THEN** the event carries:
```json
{
  "payment_id": "string",
  "amount_minor": 0
}
```
EOF

# a machine-local registry the lint can resolve
mkdir -p "$T/home/.local/share/openspec/stores"
REG="$T/home/.local/share/openspec/stores/registry.yaml"
printf 'stores:\n  acme-store:\n    local_path: %s/store\n' "$T" > "$REG"

# a spoke that PASTES the shape instead of linking it
mkdir -p "$T/spoke/openspec/changes/c1/specs/cap"
printf 'references:\n  - acme-store\n' > "$T/spoke/openspec/config.yaml"
cat > "$T/spoke/openspec/changes/c1/specs/cap/spec.md" <<'EOF'
## ADDED Requirements
### Requirement: Payment captured event
This repository consumes the event whose payload is:
```json
{
  "payment_id": "string",
  "amount_minor": 0
}
```

#### Scenario: ok
- **WHEN** the event arrives
- **THEN** a row is stored
EOF

out=$(cd "$T/spoke" && OPENSPEC_STORE_REGISTRY="$REG" node "$LINT" . 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q 'acme-store:add-payments' <<<"$out"; then
  ok "a shape copied from an UNARCHIVED store contract is caught"
else
  no "the lint was blind during the cross-repo window (rc=$rc)" "$out"
fi

# the same spoke, linking instead of pasting
cat > "$T/spoke/openspec/changes/c1/specs/cap/spec.md" <<'EOF'
## ADDED Requirements
### Requirement: Capture event is consumed here
This repository stores the payment id it reads from the contract.

Contract: payments-events-v2 in store acme-store (change add-payments)

#### Scenario: ok
- **WHEN** the event arrives
- **THEN** a row is stored
EOF
out=$(cd "$T/spoke" && OPENSPEC_STORE_REGISTRY="$REG" node "$LINT" . 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then ok "linking instead of pasting passes"; else no "a linking spoke was rejected (rc=$rc)" "$out"; fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
