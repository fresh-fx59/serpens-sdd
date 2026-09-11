# Research — <change-id>

<!-- append-only; pointers not payloads; one line per fact -->
- src/payments/api/PaymentApi.java#L14-L22 — refund() takes minor units; no partial-refund overload today
- ../billing-repo: openspec/specs/invoicing/spec.md#R4 — invoices lock 24h after issue (affects refund window)
- TRACKER-123 comment 2026-07-18 — analyst confirmed: partial refunds NOT in scope this change
