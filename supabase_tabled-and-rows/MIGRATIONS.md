# Migration Ledger — EGParts Supabase

Single source of truth for database migration files in this folder.
Every schema change MUST land here as a numbered, idempotent SQL file
(`IF EXISTS` / `IF NOT EXISTS` / `CREATE OR REPLACE`) and get a row below.

Rules:

- Never edit an already-applied migration; add a new numbered file.
- Apply to the **Dev** project first (`ubkjyktgbxvzyuraapfl`), verify with a
  read-only or rolled-back query, then promote to Production.
- Do not rely on manual SQL in dashboards; if it happened anyway, backfill it
  here as a file so environments stay reproducible.

## Known numbering gaps

- Missing numbers: 1–10, 12–17, 31, 33–40, 42, 74 (history predates this
  ledger / files were consolidated). The gaps are intentional placeholders —
  do not renumber existing applied files.
- **Duplicate number 76**: `76_add_user_address_location_url.sql` and
  `76_optimize_phone_verification_rls.sql`. Both are already applied to Dev;
  they must NOT be renamed (order of application is recorded by content).
  New migrations continue from the highest number + 1 only.

## Applied migrations

| # | File | Purpose | Dev | Prod |
|---|------|---------|-----|------|
| 11 | 11_subscription_limit_engine.sql | Subscription limit engine (checks, reservations RPCs, triggers) | ✅ | ✅ |
| 18 | 18_fix_limit_trigger.sql | Fix feature-limit trigger | ✅ | ✅ |
| 19 | 19_multi_niche_copilot.sql | Multi-niche copilot support | ✅ | ✅ |
| 20 | 20_fix_feature_reservations_amount.sql | Reservations amount fix | ✅ | ✅ |
| 21 | 21_recreate_limit_functions.sql | Recreate limit functions | ✅ | ✅ |
| 22 | 22_add_whatsapp_group_link.sql | WhatsApp group link setting | ✅ | ✅ |
| 23 | 23_add_social_links_json.sql | Social links JSON setting | ✅ | ✅ |
| 24 | 24_copilot_limits.sql | Copilot limits | ✅ | ✅ |
| 25 | 25_fix_notification_queue_store_id.sql | Notification queue store scoping | ✅ | ✅ |
| 26 | 26_banners_plan_limit.sql | Banners plan limit | ✅ | ✅ |
| 27 | 27_sync_images_triggers.sql | Image usage sync triggers | ✅ | ✅ |
| 28 | 28_update_plan_limits.sql | Plan limits update | ✅ | ✅ |
| 29 | 29_drop_phone_constraints.sql | Drop legacy phone constraints | ✅ | ✅ |
| 30 | 30_fix_boolean_feature_limits.sql | Boolean feature limits semantics | ✅ | ✅ |
| 32 | 32_invitation_phone_support.sql | Invitations via phone | ✅ | ✅ |
| 41 | 41_drop_redundant_stock_trigger.sql | Drop redundant stock trigger | ✅ | ✅ |
| 43 | 43_whatsapp_pool_cost_and_limit_contract.sql | Pool cost/limit contract | ✅ | ✅ |
| 44 | 44_canonical_feature_limit_semantics.sql | Canonical limit semantics | ✅ | ✅ |
| 45 | 45_lock_privileged_limit_rpc.sql | Lock privileged limit RPCs | ✅ | ✅ |
| 46 | 46_contract_hardening.sql | Contract hardening | ✅ | ✅ |
| 47 | 47_whatsapp_atomic_claim.sql | Atomic WhatsApp account claim | ✅ | ✅ |
| 48 | 48_order_whatsapp_notification_controls.sql | Order notification controls | ✅ | ✅ |
| 49 | 49_security_advisor_remediation.sql | Security advisor remediations | ✅ | ✅ |
| 50 | 50_restrict_security_definer_execution.sql | Restrict SECURITY DEFINER EXECUTE | ✅ | ✅ |
| 51 | 51_fk_indexes_and_rls_initplan.sql | FK indexes + RLS initplan | ✅ | ✅ |
| 52 | 52_finalize_fk_index_advisor.sql | Finalize FK index advisor fixes | ✅ | ✅ |
| 53 | 53_remove_remaining_duplicate_indexes.sql | Remove duplicate indexes | ✅ | ✅ |
| 54 | 54_scope_rls_policies.sql | Scope RLS policies | ✅ | ✅ |
| 55 | 55_drop_last_duplicate_index.sql | Drop last duplicate index | ✅ | ✅ |
| 56 | 56_remove_exact_duplicate_policies.sql | Remove exact duplicate policies | ✅ | ✅ |
| 57 | 57_atomic_stock_restore.sql | Atomic stock restore RPC | ✅ | ✅ |
| 58 | 58_store_scoped_notification_preferences.sql | Store-scoped notification prefs | ✅ | ✅ |
| 59 | 59_runtime_query_indexes.sql | Runtime query indexes | ✅ | ✅ |
| 60 | 60_remove_unknown_plan_feature.sql | Remove unknown plan feature | ✅ | ✅ |
| 61 | 61_assign_platform_owner_to_pool_accounts.sql | Platform owner for pool accounts | ✅ | ✅ |
| 62 | 62_payment_lifecycle_hardening.sql | Payment lifecycle hardening | ✅ | ✅ |
| 63 | 63_restore_coupon_on_payment_failure.sql | Restore coupon on payment failure | ✅ | ✅ |
| 64 | 64_fix_boolean_feature_limit_semantics.sql | Boolean limit semantics fix | ✅ | ✅ |
| 65 | 65_fix_order_idempotency_constraint.sql | Order idempotency constraint | ✅ | ✅ |
| 66 | 66_fix_notification_idempotency_constraint.sql | Notification idempotency constraint | ✅ | ✅ |
| 67 | 67_remove_unneeded_order_idempotency_index.sql | Drop redundant order index | ✅ | ✅ |
| 68 | 68_fix_payment_outbox_conflict_constraint.sql | Payment outbox conflict target | ✅ | ✅ |
| 69 | 69_add_order_paid_at.sql | orders.paid_at column | ✅ | ✅ |
| 70 | 70_payment_proof_retention.sql | Payment proof retention policy | ✅ | ✅ |
| 71 | 71_account_phone_verification.sql | Account phone verification | ✅ | ✅ |
| 72 | 72_fix_phone_verification_ambiguity.sql | Phone verification ambiguity fix | ✅ | ✅ |
| 73 | 73_fix_phone_verification_user_id_ambiguity.sql | user_id ambiguity fix | ✅ | ✅ |
| 75 | 75_expand_store_business_types.sql | Expand store business types | ✅ | ✅ |
| 76a | 76_add_user_address_location_url.sql | user_addresses.location_url | ✅ | ✅ |
| 76b | 76_optimize_phone_verification_rls.sql | Phone verification RLS optimization | ✅ | ✅ |
| 77 | 77_fix_remaining_advisor_indexes.sql | Remaining advisor indexes | ✅ | ✅ |
| 78 | 78_consolidate_overlapping_rls.sql | Consolidate overlapping RLS | ✅ | ✅ |
| 79 | 79_isolate_rls_helper_functions.sql | Isolate RLS helper functions | ✅ | ✅ |
| 80 | 80_atomic_manual_wallet_rejection.sql | Atomic manual wallet rejection | ✅ | ✅ |
| 81 | 81_harden_all_security_definer_search_path.sql | search_path on all SECURITY DEFINER fns | ✅ | ✅ |
| 82 | 82_tenant_bind_quota_reservations.sql | Tenant-bind commit/rollback reservation RPCs (`p_expected_store_id`) | ✅ 2026-08-22 | ❌ forbidden until verified |
| 83 | 83_drop_legacy_quota_overloads_and_harden.sql | Drop legacy single-arg quota overloads (anon/authenticated EXECUTABLE); re-run search_path hardening; service_role-only grants on bound quota RPCs | ✅ 2026-08-22 | ❌ forbidden until verified |

| 84 | 84_dev_2fa_settings_and_fk_indexes.sql | Create missing user_2fa_settings (+deny-all RLS) and complete 52's FK indexes with existence guards | ✅ 2026-08-22 | ❌ forbidden until verified |
| 85 | 85_plan_features_fk_index.sql | plan_features FK index on real column feature_id | ✅ 2026-08-22 | ❌ forbidden until verified |
| 86 | 86_deny_all_policies_for_policyless_rls_tables.sql | Explicit deny_public_api_* policies for every RLS-on/no-policy table (33 on Dev; frontend verified zero direct table/rpc access) | ✅ 2026-08-22 | ❌ forbidden until verified |
| 87 | 87_drop_duplicate_nonconstraint_indexes.sql | Drop two true duplicate btree twins (order_items.order_id, products store/active/deleted); seven unique-constraint pairs intentionally kept — dropping a constraint side alters ON CONFLICT semantics | ✅ 2026-08-22 | ❌ forbidden until verified |

## Applied-late note (2026-08-22) — CRITICAL functional impact

Live authenticated E2E exposed that Dev was ALSO missing index-only migrations
that no table audit could catch:

- **65** `orders_idempotency_key_unique` — absent → EVERY order creation on Dev
  failed with 42P10 (`ON CONFLICT` had no arbiter). Root cause of the
  "orders always fail" symptom.
- **66** notification_queue idempotency index redefined from PARTIAL to full —
  name-based audits saw it "present" while the definition was incompatible.
- **62/68** payment_outbox idempotency unique — wallet/payment outbox upserts
  were broken the same way.
- Plus FK/perf sets 32/52/58/59/77 and table fixes 19/43/48/70/71/72/73/84/85.
- **Function/column-only migrations** (invisible to both table and index audits):
  - **57** `restore_order_stock(uuid)` — absent → wallet rejection crashed
    (`function does not exist`), stock never restored on Dev.
  - **69** `orders.paid_at` column — absent → `approve_manual_wallet_payment`
    crashed with `column paid_at does not exist`; COD delivery settlement
    timestamp impossible.
  - **80** `reject_manual_wallet_payment(uuid,uuid,uuid,text)` — absent entirely;
    the older 3-arg approve existed while reject did not.

All applied to Dev on 2026-08-22. Verified by live tests afterwards:
COD order creation 201 → idempotent replay same orderId; manual-wallet lifecycle
14/14 (approve → paid/confirmed/paid_at, double-approve refused, reject →
payment failed + stock restored); cross-store IDOR probes show zero data
leakage across three tenants; IDOR write attacks (delete/patch foreign user's
address, patch via foreign store context) silently no-op with resource intact.

Lesson codified twice over: (1) never assume a migration is applied because the
file exists; (2) index audits must compare DEFINITIONS (partial vs full), not
just names — see scripts/pg-index-audit.js SUPERSEDED note.

## Verification evidence

- `audit/advisors-before.json` / `audit/advisors-after.json`: search_path gaps 24→0;
  wide definer grants reduced after dropping legacy overloads.
- `node scripts/pg-test-quota-binding.js`: 7/7 PASS on Dev (foreign-store
  commit/rollback refused, owner rollback works, legacy shape preserved).
