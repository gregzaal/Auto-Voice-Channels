-- Rolling-deploy safety for member pools (plans/member-based-pricing.md
-- §6.5, phase 9's hard gate): ships the pool pass DISABLED so it cannot run
-- on any instance until phase 4's reconciler code is deployed everywhere,
-- including the rollback target. Flip it off via
-- RuntimeFlagsRepository.set('pooling.disabled', false, ...) only once that
-- holds, and only alongside the announcement in plan phase 9.
--
-- Seeded under fleet = 'prod' deliberately: `pooling.disabled` is read by a
-- RuntimeFlagsRepository pinned to DEFAULT_FLEET ('prod'), never by the
-- reading instance's own fleet, because the pool pass is a cluster
-- singleton on shared rows (`plans/member-based-pricing.md` §6.5) exactly
-- like the `billing.advance` advisory lock. Seeding under any other fleet
-- would write a row the pool pass never reads and ship it enabled by
-- omission, the exact trap the same section documents for 0007's pattern.
--
-- ON CONFLICT (fleet, key), not (key): migration 0017 moved the primary key
-- to (fleet, key) and 0007's older `ON CONFLICT (key) DO NOTHING` would
-- error on that constraint shape today. Never copy 0007's clause verbatim.
INSERT INTO runtime_flags (fleet, key, value, description, updated_by)
VALUES (
  'prod',
  'pooling.disabled',
  'true'::jsonb,
  'Seeded off for the member-pools rollout - enable once every instance, including the rollback target, runs pool-pass-aware code.',
  'migration-0027'
)
ON CONFLICT (fleet, key) DO NOTHING;
