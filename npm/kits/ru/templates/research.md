# Исследование — <change-id>

<!-- append-only; pointers not payloads; one line per fact -->
- src/payments/api/PaymentApi.java#L14-L22 — refund() принимает минорные единицы; перегрузки для частичного возврата сегодня нет
- ../billing-repo: openspec/specs/invoicing/spec.md#R4 — счета блокируются через 24ч после выставления (влияет на окно возврата)
- TRACKER-123 comment 2026-07-18 — аналитик подтвердил: частичные возвраты НЕ в объёме этого изменения
