-- Rolling-deploy safety for the `grace` auth-status expansion (expand/contract,
-- AGENTS.md golden rules 3-4): the billing reconcile job is the first writer of
-- `grace` rows, and instances still running the PREVIOUS version reject that
-- value in their zod row schema (every settings-cache read of such a guild
-- would throw). Ship the writer DISABLED; flip the flag off via
-- RuntimeFlagsRepository.set('billing.reconcile_disabled', false, ...) once the
-- whole fleet (and the rollback target) runs a grace-aware build.
--
-- ON CONFLICT DO NOTHING: an operator's explicit later value always wins over
-- a re-run of this migration.
INSERT INTO runtime_flags (key, value, description, updated_by)
VALUES (
  'billing.reconcile_disabled',
  'true'::jsonb,
  'Seeded off for the grace rollout - enable once all instances run a grace-aware build.',
  'migration-0007'
)
ON CONFLICT (key) DO NOTHING;
