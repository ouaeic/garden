import { CONVERSATION_NAME_INDEX_STAMP } from '@garden/core';

export const migrations = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        recovery_hash TEXT,
        plan_id TEXT NOT NULL DEFAULT 'community',
        payment_customer_ref TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS passkeys (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        counter BIGINT NOT NULL DEFAULT 0,
        transports JSONB NOT NULL DEFAULT '[]'::jsonb,
        device_type TEXT NOT NULL,
        backed_up BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS passkeys_user_idx ON passkeys(user_id);

      CREATE TABLE IF NOT EXISTS auth_challenges (
        id UUID PRIMARY KEY,
        username TEXT,
        challenge TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS workspaces (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        shape TEXT NOT NULL,
        status TEXT NOT NULL,
        storage_bytes BIGINT NOT NULL DEFAULT 0,
        storage_limit_bytes BIGINT NOT NULL,
        image_revision TEXT NOT NULL,
        region TEXT NOT NULL,
        runner_ref TEXT,
        last_active_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS workspaces_user_idx ON workspaces(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS workspace_keys (
        workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        key_version INTEGER NOT NULL DEFAULT 1,
        wrapped_key TEXT NOT NULL,
        wrapping_mode TEXT NOT NULL DEFAULT 'hosted',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        rotated_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        model_id TEXT NOT NULL,
        privacy_route TEXT NOT NULL,
        max_compute_credits DOUBLE PRECISION NOT NULL,
        reserved_compute_credits DOUBLE PRECISION NOT NULL DEFAULT 0,
        actual_compute_credits DOUBLE PRECISION NOT NULL DEFAULT 0,
        prompt_ciphertext JSONB NOT NULL,
        agent_state_ciphertext JSONB,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        attempt INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks(status, created_at);

      CREATE TABLE IF NOT EXISTS task_events (
        id UUID PRIMARY KEY,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_ciphertext JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(task_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS task_events_cursor_idx ON task_events(task_id, sequence);

      CREATE TABLE IF NOT EXISTS artifacts (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        name_ciphertext JSONB NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        version INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS artifacts_workspace_idx ON artifacts(workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS approvals (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        origin TEXT,
        side_effect TEXT NOT NULL,
        preview_ciphertext JSONB NOT NULL,
        preview_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at TIMESTAMPTZ NOT NULL,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS approvals_user_idx ON approvals(user_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS capability_grants (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        origin TEXT,
        uses_remaining INTEGER,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS model_releases (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        revision TEXT NOT NULL,
        availability TEXT NOT NULL,
        openness TEXT NOT NULL,
        license TEXT NOT NULL,
        commercial_use BOOLEAN NOT NULL,
        privacy_route TEXT NOT NULL,
        context_tokens INTEGER NOT NULL,
        modalities JSONB NOT NULL,
        capabilities JSONB NOT NULL,
        usage_class TEXT NOT NULL,
        recommendation_tags JSONB NOT NULL,
        measured_quality DOUBLE PRECISION,
        measured_latency_ms DOUBLE PRECISION,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS provider_connections (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        secret_ciphertext JSONB NOT NULL,
        base_url TEXT,
        privacy_route TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS usage_entries (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        resource_class TEXT NOT NULL,
        quantity DOUBLE PRECISION NOT NULL,
        unit TEXT NOT NULL,
        credits DOUBLE PRECISION NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released', 'credited')),
        provider_ref TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS usage_user_period_idx ON usage_entries(user_id, created_at);

      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL,
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,
        included_credits DOUBLE PRECISION NOT NULL,
        overage_limit_credits DOUBLE PRECISION NOT NULL DEFAULT 0,
        storage_limit_bytes BIGINT NOT NULL,
        external_ref TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS browser_leases (
        workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        holder TEXT NOT NULL CHECK (holder IN ('agent', 'user', 'secure_input')),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS idempotency_records (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(user_id, idempotency_key)
      );
    `
  },
  {
    version: 2,
    name: 'media_jobs',
    sql: `
      CREATE TABLE IF NOT EXISTS media_jobs (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image','video','audio')),
        status TEXT NOT NULL DEFAULT 'queued',
        model_id TEXT NOT NULL,
        prompt_ciphertext JSONB NOT NULL,
        parameters_ciphertext JSONB NOT NULL,
        result_ciphertext JSONB,
        max_credits DOUBLE PRECISION NOT NULL,
        actual_credits DOUBLE PRECISION NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        attempt INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS media_jobs_queue_idx ON media_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS media_jobs_user_idx ON media_jobs(user_id, created_at DESC);
    `
  },
  {
    version: 3,
    name: 'privacy_operations_and_artifact_versions',
    sql: `
      CREATE TABLE IF NOT EXISTS api_operations (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running','completed','failed')),
        response_status INTEGER,
        response_body JSONB,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS api_operations_expiry_idx ON api_operations(expires_at);

      CREATE TABLE IF NOT EXISTS webhook_events (
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(provider, event_id)
      );

      CREATE TABLE IF NOT EXISTS security_events (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        outcome TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS security_events_user_idx ON security_events(user_id, created_at DESC);

      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS logical_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS artifacts_logical_version_idx
        ON artifacts(workspace_id, logical_key, version);
    `
  },
  {
    version: 4,
    name: 'cloud_only_privacy_routes',
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_cloud_privacy_route') THEN
          ALTER TABLE tasks ADD CONSTRAINT tasks_cloud_privacy_route
            CHECK (privacy_route IN ('ollama_zdr','external'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'models_cloud_privacy_route') THEN
          ALTER TABLE model_releases ADD CONSTRAINT models_cloud_privacy_route
            CHECK (privacy_route IN ('ollama_zdr','external'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'providers_cloud_privacy_route') THEN
          ALTER TABLE provider_connections ADD CONSTRAINT providers_cloud_privacy_route
            CHECK (privacy_route IN ('ollama_zdr','external'));
        END IF;
      END $$;
    `
  },
  {
    version: 5,
    name: 'content_free_push_notifications',
    sql: `
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
        ON push_subscriptions(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        subscription_id UUID NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('approval_required','task_finished')),
        resource_id UUID NOT NULL,
        delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(subscription_id, kind, resource_id)
      );
      CREATE INDEX IF NOT EXISTS notification_deliveries_time_idx
        ON notification_deliveries(delivered_at);
    `
  },
  {
    version: 6,
    name: 'user_visible_sessions',
    sql: `
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS public_id UUID;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_label TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id_idx ON sessions(public_id);
      CREATE INDEX IF NOT EXISTS sessions_user_active_idx
        ON sessions(user_id, expires_at DESC);
      ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS session_public_id UUID
        REFERENCES sessions(public_id) ON DELETE CASCADE;
    `
  },
  {
    version: 7,
    name: 'passkey_step_up_sessions',
    // The challenge-kind constraint was widened again by 9 and 10. Re-applying this one on top of
    // those would narrow it back and fail against any live recovery or passkey_add challenge, so
    // it stands down once a later migration has already taken the decision.
    sql: `
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS step_up_at TIMESTAMPTZ;
      DO $ath$ BEGIN
        IF EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 9) THEN RETURN; END IF;
        ALTER TABLE auth_challenges DROP CONSTRAINT IF EXISTS auth_challenges_kind_check;
        ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_kind_check
          CHECK (kind IN ('registration', 'authentication', 'step_up'));
      END $ath$;
    `
  },
  {
    version: 8,
    name: 'workspace_volume_snapshots',
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_snapshots (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('creating','ready','failed','deleting')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS workspace_snapshots_user_idx
        ON workspace_snapshots(user_id, workspace_id, created_at DESC);
    `
  },
  {
    version: 9,
    name: 'passkey_account_recovery',
    // Superseded by 10 in the same way migration 7 is superseded by this one.
    sql: `
      DO $ath$ BEGIN
        IF EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 10) THEN RETURN; END IF;
        ALTER TABLE auth_challenges DROP CONSTRAINT IF EXISTS auth_challenges_kind_check;
        ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_kind_check
          CHECK (kind IN ('registration', 'authentication', 'step_up', 'recovery'));
      END $ath$;
    `
  },
  {
    version: 10,
    name: 'additional_passkeys',
    sql: `
      ALTER TABLE auth_challenges DROP CONSTRAINT IF EXISTS auth_challenges_kind_check;
      ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_kind_check
        CHECK (kind IN ('registration', 'authentication', 'step_up', 'recovery', 'passkey_add'));
    `
  },
  {
    version: 11,
    name: 'durable_task_schedules',
    sql: `
      CREATE TABLE IF NOT EXISTS task_schedules (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title_ciphertext JSONB NOT NULL,
        prompt_ciphertext JSONB NOT NULL,
        model_id TEXT NOT NULL,
        privacy_route TEXT NOT NULL CHECK (privacy_route IN ('ollama_zdr','external')),
        max_compute_credits DOUBLE PRECISION NOT NULL CHECK (max_compute_credits > 0),
        spec JSONB NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        next_run_at TIMESTAMPTZ,
        last_run_at TIMESTAMPTZ,
        last_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        last_error_code TEXT,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS task_schedules_user_idx
        ON task_schedules(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS task_schedules_due_idx
        ON task_schedules(enabled, next_run_at)
        WHERE enabled = TRUE;

      CREATE TABLE IF NOT EXISTS task_schedule_runs (
        schedule_id UUID NOT NULL REFERENCES task_schedules(id) ON DELETE CASCADE,
        scheduled_for TIMESTAMPTZ NOT NULL,
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('queued','failed')),
        error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(schedule_id, scheduled_for)
      );
      CREATE INDEX IF NOT EXISTS task_schedule_runs_task_idx ON task_schedule_runs(task_id);
    `
  },
  {
    version: 12,
    name: 'capability_scoped_connectors',
    sql: `
      CREATE TABLE IF NOT EXISTS connectors (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('github','webdav')),
        label TEXT NOT NULL,
        base_url TEXT NOT NULL,
        scopes JSONB NOT NULL,
        secret_ciphertext JSONB NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS connectors_user_idx
        ON connectors(user_id, enabled, created_at DESC);

      CREATE TABLE IF NOT EXISTS connector_audit_events (
        id UUID PRIMARY KEY,
        connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        operation TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','denied')),
        status_code INTEGER,
        request_bytes INTEGER NOT NULL DEFAULT 0 CHECK (request_bytes >= 0),
        response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
        duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS connector_audit_user_idx
        ON connector_audit_events(user_id, created_at DESC);
    `
  },
  {
    version: 13,
    name: 'authenticated_workspace_previews',
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_previews (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        port INTEGER NOT NULL CHECK (port BETWEEN 1024 AND 65535 AND port <> 4300),
        slug TEXT NOT NULL UNIQUE,
        access_token_hash TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
        expires_at TIMESTAMPTZ NOT NULL,
        last_accessed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS workspace_previews_user_idx
        ON workspace_previews(user_id, workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS workspace_previews_active_idx
        ON workspace_previews(slug, expires_at) WHERE status='active';
    `
  },
  {
    version: 14,
    name: 'revocable_scoped_api_tokens',
    sql: `
      CREATE TABLE IF NOT EXISTS api_tokens (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        scopes JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS api_tokens_user_idx
        ON api_tokens(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS api_tokens_active_idx
        ON api_tokens(token_hash, expires_at) WHERE revoked_at IS NULL;
    `
  },
  {
    version: 15,
    name: 'organizations_and_shared_workspaces',
    sql: `
      CREATE TABLE IF NOT EXISTS organizations (
        id UUID PRIMARY KEY,
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        policy JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS organization_members (
        organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (organization_id,user_id)
      );
      CREATE INDEX IF NOT EXISTS organization_members_user_idx
        ON organization_members(user_id,joined_at DESC);
      CREATE TABLE IF NOT EXISTS organization_workspaces (
        organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
        added_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (organization_id,workspace_id)
      );
      CREATE INDEX IF NOT EXISTS organization_workspaces_org_idx
        ON organization_workspaces(organization_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS organization_audit_events (
        id UUID PRIMARY KEY,
        organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        target_id UUID,
        outcome TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS organization_audit_idx
        ON organization_audit_events(organization_id,created_at DESC);
    `
  },
  {
    version: 16,
    name: 'versioned_editable_task_plans',
    sql: `
      CREATE TABLE IF NOT EXISTS task_plans (
        id UUID PRIMARY KEY,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        parent_version INTEGER,
        branch_name TEXT NOT NULL,
        steps_ciphertext JSONB NOT NULL,
        created_by TEXT NOT NULL CHECK (created_by IN ('agent','user')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(task_id,version)
      );
      CREATE INDEX IF NOT EXISTS task_plans_task_idx
        ON task_plans(task_id,version DESC);
    `
  },
  {
    version: 17,
    name: 'attested_key_release_receipts',
    sql: `
      UPDATE workspace_keys SET wrapping_mode='hosted'
        WHERE wrapping_mode NOT IN ('hosted','attested');
      ALTER TABLE workspace_keys DROP CONSTRAINT IF EXISTS workspace_keys_wrapping_mode_check;
      ALTER TABLE workspace_keys
        ADD CONSTRAINT workspace_keys_wrapping_mode_check
        CHECK (wrapping_mode IN ('hosted','attested'));
      CREATE TABLE IF NOT EXISTS key_release_receipts (
        id UUID PRIMARY KEY,
        service TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        image_digest TEXT NOT NULL,
        hardware TEXT NOT NULL,
        attested_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS key_release_receipts_service_idx
        ON key_release_receipts(service,created_at DESC);
    `
  },
  {
    version: 18,
    name: 'hosted_provider_only_routes',
    // This one deletes and rewrites rows rather than only touching the schema, and migration 21
    // replaced 'ollama_zdr' with 'provider_zdr' afterwards. Re-applying it on a database that has
    // already reached 21 would rewrite every provider_zdr task to 'external' and delete the whole
    // model catalogue, so it stands down entirely once its successor has run.
    sql: `
      DO $ath$ BEGIN
        IF EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 21) THEN RETURN; END IF;

        UPDATE tasks SET privacy_route='external'
          WHERE privacy_route NOT IN ('ollama_zdr','external');
        UPDATE task_schedules SET privacy_route='external'
          WHERE privacy_route NOT IN ('ollama_zdr','external');
        DELETE FROM model_releases
          WHERE privacy_route NOT IN ('ollama_zdr','external');
        DELETE FROM provider_connections
          WHERE privacy_route NOT IN ('ollama_zdr','external');

        ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_cloud_privacy_route;
        ALTER TABLE tasks ADD CONSTRAINT tasks_cloud_privacy_route
          CHECK (privacy_route IN ('ollama_zdr','external'));
        ALTER TABLE model_releases DROP CONSTRAINT IF EXISTS models_cloud_privacy_route;
        ALTER TABLE model_releases ADD CONSTRAINT models_cloud_privacy_route
          CHECK (privacy_route IN ('ollama_zdr','external'));
        ALTER TABLE provider_connections DROP CONSTRAINT IF EXISTS providers_cloud_privacy_route;
        ALTER TABLE provider_connections ADD CONSTRAINT providers_cloud_privacy_route
          CHECK (privacy_route IN ('ollama_zdr','external'));
        ALTER TABLE task_schedules DROP CONSTRAINT IF EXISTS task_schedules_privacy_route_check;
        ALTER TABLE task_schedules ADD CONSTRAINT task_schedules_privacy_route_check
          CHECK (privacy_route IN ('ollama_zdr','external'));
      END $ath$;
    `
  },
  {
    version: 19,
    name: 'workspace_compute_metering',
    sql: `
      ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS compute_metered_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS workspaces_compute_meter_idx
        ON workspaces(status,compute_metered_at)
        WHERE status='running';
    `
  },
  {
    version: 20,
    name: 'snapshot_storage_accounting',
    sql: `
      ALTER TABLE workspace_snapshots
        ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0;
    `
  },
  {
    version: 21,
    name: 'provider_neutral_hosted_inference',
    sql: `
      ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_cloud_privacy_route;
      ALTER TABLE model_releases DROP CONSTRAINT IF EXISTS models_cloud_privacy_route;
      ALTER TABLE provider_connections DROP CONSTRAINT IF EXISTS providers_cloud_privacy_route;
      ALTER TABLE task_schedules DROP CONSTRAINT IF EXISTS task_schedules_privacy_route_check;

      UPDATE tasks SET privacy_route='provider_zdr' WHERE privacy_route='ollama_zdr';
      UPDATE task_schedules SET privacy_route='provider_zdr' WHERE privacy_route='ollama_zdr';
      UPDATE model_releases SET privacy_route='provider_zdr' WHERE privacy_route='ollama_zdr';
      UPDATE provider_connections SET privacy_route='provider_zdr' WHERE privacy_route='ollama_zdr';

      ALTER TABLE tasks ADD CONSTRAINT tasks_cloud_privacy_route
        CHECK (privacy_route IN ('provider_zdr','external'));
      ALTER TABLE model_releases ADD CONSTRAINT models_cloud_privacy_route
        CHECK (privacy_route IN ('provider_zdr','external'));
      ALTER TABLE provider_connections ADD CONSTRAINT providers_cloud_privacy_route
        CHECK (privacy_route IN ('provider_zdr','external'));
      ALTER TABLE task_schedules ADD CONSTRAINT task_schedules_privacy_route_check
        CHECK (privacy_route IN ('provider_zdr','external'));

      ALTER TABLE model_releases ADD COLUMN IF NOT EXISTS provider_model_id TEXT;
      UPDATE model_releases SET provider_model_id=id WHERE provider_model_id IS NULL;
      ALTER TABLE model_releases ALTER COLUMN provider_model_id SET NOT NULL;

      ALTER TABLE provider_connections
        ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
    `
  },
  {
    version: 22,
    name: 'resumable_workspace_orders',
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_orders (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        request_ciphertext JSONB NOT NULL,
        required_plan_id TEXT NOT NULL CHECK (required_plan_id IN ('core','pro','power')),
        storage_addon_blocks INTEGER NOT NULL DEFAULT 0 CHECK (storage_addon_blocks >= 0),
        status TEXT NOT NULL CHECK (status IN (
          'pending_checkout','pending_payment','provisioning','completed','failed','cancelled'
        )),
        checkout_session_ref TEXT,
        workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
        failure_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS workspace_orders_user_idx
        ON workspace_orders(user_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS workspace_orders_pending_idx
        ON workspace_orders(status,updated_at)
        WHERE status IN ('pending_checkout','pending_payment','provisioning');
    `
  },
  {
    version: 23,
    name: 'task_conversation_branches',
    sql: `
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID
        REFERENCES tasks(id) ON DELETE SET NULL;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS branched_from_event_id UUID
        REFERENCES task_events(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS tasks_parent_idx
        ON tasks(parent_task_id,created_at DESC) WHERE parent_task_id IS NOT NULL;
    `
  },
  {
    version: 24,
    name: 'durable_task_message_queue',
    sql: `
      CREATE TABLE IF NOT EXISTS task_message_queue (
        id UUID PRIMARY KEY,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        prompt_ciphertext JSONB NOT NULL,
        model_id TEXT NOT NULL,
        privacy_route TEXT NOT NULL CHECK (privacy_route IN ('provider_zdr','external')),
        max_compute_credits DOUBLE PRECISION NOT NULL CHECK (max_compute_credits > 0),
        resource_class TEXT NOT NULL,
        reservation_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','promoted','cancelled')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        promoted_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS task_message_queue_fifo_idx
        ON task_message_queue(task_id,created_at,id) WHERE status='queued';
    `
  },
  {
    version: 25,
    name: 'persistent_publications_and_custom_domains',
    sql: `
      ALTER TABLE workspace_previews ALTER COLUMN expires_at DROP NOT NULL;
      ALTER TABLE workspace_previews ADD COLUMN IF NOT EXISTS hosting_mode TEXT
        NOT NULL DEFAULT 'always_ready'
        CHECK (hosting_mode IN ('on_demand','always_ready'));
      ALTER TABLE workspace_previews ADD COLUMN IF NOT EXISTS custom_domain TEXT;
      ALTER TABLE workspace_previews ADD COLUMN IF NOT EXISTS domain_status TEXT
        CHECK (domain_status IN ('pending','active','failed'));
      ALTER TABLE workspace_previews ADD COLUMN IF NOT EXISTS domain_verification_hash TEXT;
      ALTER TABLE workspace_previews ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_previews_custom_domain_idx
        ON workspace_previews(LOWER(custom_domain)) WHERE custom_domain IS NOT NULL;
    `
  },
  {
    version: 26,
    name: 'trajectory_controls_and_security_modes',
    sql: `
      ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS security_mode TEXT
        NOT NULL DEFAULT 'balanced'
        CHECK (security_mode IN ('review','balanced','autonomous'));
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS security_mode TEXT
        NOT NULL DEFAULT 'balanced'
        CHECK (security_mode IN ('review','balanced','autonomous'));
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS fork_kind TEXT
        CHECK (fork_kind IN ('branch','edit','retry'));
      CREATE INDEX IF NOT EXISTS tasks_trajectory_idx
        ON tasks(parent_task_id,fork_kind,created_at DESC)
        WHERE parent_task_id IS NOT NULL;
    `
  },
  {
    version: 27,
    name: 'managed_ai_costs_and_customer_keys',
    sql: `
      ALTER TABLE usage_entries ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION
        NOT NULL DEFAULT 0 CHECK (cost_usd >= 0);
      CREATE INDEX IF NOT EXISTS usage_managed_ai_window_idx
        ON usage_entries(user_id,created_at)
        WHERE kind='model_inference' AND state='settled';

      CREATE TABLE IF NOT EXISTS managed_provider_credentials (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        secret_ciphertext JSONB NOT NULL,
        external_ref TEXT NOT NULL,
        monthly_limit_usd DOUBLE PRECISION NOT NULL CHECK (monthly_limit_usd >= 0),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','error')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(user_id,provider)
      );
    `
  },
  {
    version: 28,
    name: 'versioned_customer_legal_acceptance',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS legal_documents_version TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS legal_accepted_at TIMESTAMPTZ;
    `
  },
  {
    version: 29,
    name: 'single_computer_gpu_tier',
    sql: `
      ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS gpu_tier TEXT
        NOT NULL DEFAULT 'off'
        CHECK (gpu_tier IN ('off','boost','pro','ultra'));
    `
  },
  {
    version: 30,
    name: 'encrypted_memory_and_reviewed_skills',
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_memories (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        target TEXT NOT NULL CHECK (target IN ('workspace','user')),
        content_ciphertext JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS workspace_memories_workspace_idx
        ON workspace_memories(workspace_id,target,created_at);

      CREATE TABLE IF NOT EXISTS workspace_skills (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name_hash TEXT NOT NULL,
        document_ciphertext JSONB NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','archived')),
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(workspace_id,name_hash)
      );
      CREATE INDEX IF NOT EXISTS workspace_skills_workspace_idx
        ON workspace_skills(workspace_id,enabled,updated_at DESC);
    `
  },
  {
    version: 31,
    name: 'challenge_bound_webauthn_context',
    sql: `
      ALTER TABLE auth_challenges ADD COLUMN IF NOT EXISTS expected_origin TEXT;
      ALTER TABLE auth_challenges ADD COLUMN IF NOT EXISTS rp_id TEXT;
    `
  },
  {
    version: 32,
    name: 'mcp_http_and_durable_oauth_pairing',
    sql: `
      ALTER TABLE connectors DROP CONSTRAINT IF EXISTS connectors_kind_check;
      ALTER TABLE connectors ADD CONSTRAINT connectors_kind_check
        CHECK (kind IN ('github','webdav','mcp_http'));
      ALTER TABLE connectors ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'secret';
      ALTER TABLE connectors DROP CONSTRAINT IF EXISTS connectors_auth_mode_check;
      ALTER TABLE connectors ADD CONSTRAINT connectors_auth_mode_check
        CHECK (auth_mode IN ('secret','none','bearer','oauth'));

      CREATE TABLE IF NOT EXISTS connector_oauth_attempts (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        base_url TEXT NOT NULL,
        scopes JSONB NOT NULL,
        state_hash TEXT NOT NULL UNIQUE,
        secret_ciphertext JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS connector_oauth_attempts_expiry_idx
        ON connector_oauth_attempts(expires_at);
    `
  },
  {
    version: 33,
    name: 'deletable_accounts_and_bounded_growth',
    // organization_workspaces.added_by pointed at users(id) ON DELETE RESTRICT, which made every
    // account that ever attached a workspace to an organization undeletable - RESTRICT fires even
    // when the referencing row would itself be removed by another cascade. SET NULL is the right
    // replacement rather than CASCADE: the share is a property of the workspace, not of the person
    // who set it up, so deleting a member must not silently unshare a workspace somebody else owns.
    sql: `
      ALTER TABLE organization_workspaces ALTER COLUMN added_by DROP NOT NULL;
      DO $$
      DECLARE restricting_constraint TEXT;
      BEGIN
        FOR restricting_constraint IN
          SELECT c.conname FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
          WHERE c.conrelid='organization_workspaces'::regclass
            AND c.contype='f' AND a.attname='added_by' AND c.confdeltype<>'n'
        LOOP
          EXECUTE format(
            'ALTER TABLE organization_workspaces DROP CONSTRAINT %I',restricting_constraint
          );
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
          WHERE c.conrelid='organization_workspaces'::regclass
            AND c.contype='f' AND a.attname='added_by'
        ) THEN
          ALTER TABLE organization_workspaces
            ADD CONSTRAINT organization_workspaces_added_by_fkey
            FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS usage_entries_task_idx
        ON usage_entries(task_id) WHERE task_id IS NOT NULL;

      ALTER TABLE workspace_memories ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS workspace_memories_expiry_idx
        ON workspace_memories(valid_until) WHERE valid_until IS NOT NULL;

      CREATE INDEX IF NOT EXISTS task_events_delta_idx
        ON task_events(task_id,sequence) WHERE kind='assistant_delta';

      CREATE INDEX IF NOT EXISTS tasks_legacy_title_idx
        ON tasks(created_at) WHERE title NOT LIKE '{"v":%';
      CREATE INDEX IF NOT EXISTS task_events_legacy_summary_idx
        ON task_events(id) WHERE summary NOT LIKE 'Encrypted % event';
    `
  },
  {
    version: 34,
    name: 'device_enrollments',
    // Adding a device later must not send the owner back to a server console for the installer's
    // pairing code. An already-authenticated client mints a short-lived, single-use grant instead.
    // Only the hash is stored, so a database copy cannot be replayed into a working enrollment.
    sql: `
      CREATE TABLE IF NOT EXISTS device_enrollments(
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        issued_by_session TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS device_enrollments_user_idx
        ON device_enrollments(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS device_enrollments_expiry_idx
        ON device_enrollments(expires_at);
    `
  },
  {
    version: 35,
    name: 'tiered_agent_memory',
    // Tiered memory: an append-only verbatim layer (mem.source) that is never rewritten, and a
    // curated overlay (mem.item) of episodes, facts, procedures and entities that cites it through
    // mem.evidence. Bodies stay encrypted like every other owner artefact, so the lexical surface
    // is a keyed blind index built by @garden/core: each lexeme becomes an HMAC token before it
    // reaches the server. Positions and field weights survive that substitution, which is what
    // keeps @@, ts_rank_cd and the BM25 function below working over data the database cannot read.
    //
    // pg_trgm, btree_gin and pgvector are all attempted and all optional. Fuzzy matching therefore
    // runs on keyed trigram arrays through the built-in array GIN operator class, which computes
    // exactly the Jaccard score similarity() would - the lexical floor never depends on an
    // extension being installed, and embeddings never become load-bearing.
    sql: `
      CREATE SCHEMA IF NOT EXISTS mem;

      DO $ath$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_trgm;
      EXCEPTION WHEN OTHERS THEN NULL; END $ath$;
      DO $ath$ BEGIN CREATE EXTENSION IF NOT EXISTS btree_gin;
      EXCEPTION WHEN OTHERS THEN NULL; END $ath$;
      DO $ath$ BEGIN CREATE EXTENSION IF NOT EXISTS vector;
      EXCEPTION WHEN OTHERS THEN NULL; END $ath$;

      -- 'entity' is carried here and nowhere above. It was a declared memory kind that nothing ever
      -- wrote: the agent could filter a recall to it and always got an empty answer back, because
      -- what it described - a statement about a person, place or system - is what a fact already
      -- is. PostgreSQL has no way to drop a value from an enum in use, and inventing one would
      -- mean rewriting the type and every column that references it to remove a word no row holds.
      DO $ath$ BEGIN
        CREATE TYPE mem.kind AS ENUM ('source','episode','fact','procedure','entity');
      EXCEPTION WHEN duplicate_object THEN NULL; END $ath$;
      DO $ath$ BEGIN
        CREATE TYPE mem.trust AS ENUM ('stated','derived','inferred');
      EXCEPTION WHEN duplicate_object THEN NULL; END $ath$;
      DO $ath$ BEGIN
        CREATE TYPE mem.status AS ENUM
          ('active','superseded','disputed','archived','retracted');
      EXCEPTION WHEN duplicate_object THEN NULL; END $ath$;
      DO $ath$ BEGIN
        CREATE TYPE mem.embed_state AS ENUM ('none','pending','ok','skipped','failed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $ath$;

      CREATE TABLE IF NOT EXISTS mem.predicate (
        name TEXT PRIMARY KEY,
        cardinality TEXT NOT NULL CHECK (cardinality IN ('one','many')),
        is_temporal BOOLEAN NOT NULL DEFAULT TRUE,
        description TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mem.item (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind mem.kind NOT NULL,
        status mem.status NOT NULL DEFAULT 'active',
        trust mem.trust NOT NULL,
        document_ciphertext JSONB NOT NULL,
        title_tokens TEXT NOT NULL DEFAULT '',
        tag_tokens TEXT NOT NULL DEFAULT '',
        body_tokens TEXT NOT NULL DEFAULT '',
        tags_hashed TEXT[] NOT NULL DEFAULT '{}',
        trigrams TEXT[] NOT NULL DEFAULT '{}',
        dedupe_key TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        retired_at TIMESTAMPTZ,
        valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        valid_to TIMESTAMPTZ,
        subject_key TEXT,
        predicate TEXT REFERENCES mem.predicate(name),
        pred_functional BOOLEAN NOT NULL DEFAULT FALSE,
        object_key TEXT,
        episode_id UUID REFERENCES mem.item(id) ON DELETE SET NULL,
        task_id UUID,
        trigger_key TEXT,
        last_verified TIMESTAMPTZ,
        ok_count INTEGER NOT NULL DEFAULT 0 CHECK (ok_count >= 0),
        fail_count INTEGER NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
        pin BOOLEAN NOT NULL DEFAULT FALSE,
        use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
        cited_count INTEGER NOT NULL DEFAULT 0 CHECK (cited_count >= 0),
        neg_count INTEGER NOT NULL DEFAULT 0 CHECK (neg_count >= 0),
        last_used_at TIMESTAMPTZ,
        salience REAL NOT NULL DEFAULT 0,
        tokens_est INTEGER NOT NULL DEFAULT 0 CHECK (tokens_est >= 0),
        indexed BOOLEAN NOT NULL DEFAULT TRUE,
        tsv TSVECTOR,
        tsv_len INTEGER NOT NULL DEFAULT 0,
        embed_state mem.embed_state NOT NULL DEFAULT 'none',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (kind <> 'fact' OR (subject_key IS NOT NULL AND predicate IS NOT NULL))
      );

      CREATE TABLE IF NOT EXISTS mem.source (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        channel TEXT NOT NULL
          CHECK (channel IN ('chat','terminal','file','browser','desktop','tool')),
        role TEXT,
        task_id UUID,
        episode_id UUID REFERENCES mem.item(id) ON DELETE SET NULL,
        -- Provenance carries paths, URLs and command lines, which are content: it is sealed like
        -- the body. origin_key is the keyed hash of the locator, so an archived row that has left
        -- the lexical index is still reachable by where it came from.
        origin_ciphertext JSONB NOT NULL DEFAULT '{}'::jsonb,
        origin_key TEXT,
        body_ciphertext JSONB NOT NULL,
        chunk_ix INTEGER NOT NULL DEFAULT 0,
        chunk_of UUID,
        tokens_est INTEGER NOT NULL DEFAULT 0 CHECK (tokens_est >= 0),
        indexed BOOLEAN NOT NULL DEFAULT TRUE,
        body_tokens TEXT NOT NULL DEFAULT '',
        tsv TSVECTOR,
        tsv_len INTEGER NOT NULL DEFAULT 0,
        embed_state mem.embed_state NOT NULL DEFAULT 'none',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS mem.link (
        src_id UUID NOT NULL REFERENCES mem.item(id) ON DELETE CASCADE,
        dst_id UUID NOT NULL,
        rel TEXT NOT NULL CHECK
          (rel IN ('supersedes','contradicts','supports','derived_from','about','part_of')),
        weight REAL NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (src_id, dst_id, rel)
      );

      CREATE TABLE IF NOT EXISTS mem.evidence (
        item_id UUID NOT NULL REFERENCES mem.item(id) ON DELETE CASCADE,
        source_id UUID NOT NULL REFERENCES mem.source(id) ON DELETE CASCADE,
        span INT4RANGE,
        PRIMARY KEY (item_id, source_id)
      );

      CREATE TABLE IF NOT EXISTS mem.item_use (
        id UUID PRIMARY KEY,
        item_id UUID NOT NULL REFERENCES mem.item(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        task_id UUID,
        used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cited BOOLEAN NOT NULL DEFAULT FALSE,
        outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('ok','fail','unknown'))
      );

      CREATE TABLE IF NOT EXISTS mem.fact_candidate (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        subject_key TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object_key TEXT NOT NULL,
        n_episodes INTEGER NOT NULL DEFAULT 1 CHECK (n_episodes > 0),
        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        episode_ids UUID[] NOT NULL DEFAULT '{}',
        draft_ciphertext JSONB,
        PRIMARY KEY (workspace_id, subject_key, predicate, object_key)
      );

      CREATE TABLE IF NOT EXISTS mem.lexeme_df (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        lexeme TEXT NOT NULL,
        df BIGINT NOT NULL DEFAULT 1,
        PRIMARY KEY (workspace_id, lexeme)
      );

      CREATE TABLE IF NOT EXISTS mem.corpus_stats (
        workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        n_docs BIGINT NOT NULL DEFAULT 0,
        sum_len BIGINT NOT NULL DEFAULT 0,
        refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS mem.pack (
        task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        brief_version TEXT,
        body_ciphertext JSONB NOT NULL,
        sha256 TEXT NOT NULL,
        item_ids UUID[] NOT NULL,
        tokens_est INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- The weighted tsvector and its token count have to be produced together: a generated column
      -- is computed after BEFORE triggers, so tsv_len could not be derived from it, and on PG18 a
      -- generated column without STORED is VIRTUAL and cannot back an index at all.
      CREATE OR REPLACE FUNCTION mem.index_row() RETURNS trigger LANGUAGE plpgsql AS $ath$
      BEGIN
        IF TG_TABLE_NAME = 'item' THEN
          IF NEW.indexed THEN
            NEW.tsv :=
                setweight(to_tsvector('simple', NEW.title_tokens), 'A')
             || setweight(to_tsvector('simple', NEW.tag_tokens), 'B')
             || setweight(to_tsvector('simple', NEW.body_tokens), 'D');
          ELSE
            NEW.tsv := NULL;
          END IF;
          NEW.pred_functional := NEW.predicate IS NOT NULL AND EXISTS (
            SELECT 1 FROM mem.predicate p
            WHERE p.name = NEW.predicate AND p.cardinality = 'one');
        ELSE
          NEW.tsv := CASE WHEN NEW.indexed
            THEN setweight(to_tsvector('simple', NEW.body_tokens), 'D') ELSE NULL END;
        END IF;
        NEW.tsv_len := COALESCE(
          (SELECT SUM(COALESCE(array_length(positions, 1), 1)) FROM unnest(NEW.tsv)), 0)::int;
        RETURN NEW;
      END $ath$;

      CREATE OR REPLACE TRIGGER t_mem_item_index
        BEFORE INSERT OR UPDATE OF title_tokens, tag_tokens, body_tokens, predicate, indexed
        ON mem.item FOR EACH ROW EXECUTE FUNCTION mem.index_row();
      CREATE OR REPLACE TRIGGER t_mem_source_index
        BEFORE INSERT OR UPDATE OF body_tokens, indexed
        ON mem.source FOR EACH ROW EXECUTE FUNCTION mem.index_row();

      -- Document frequency is maintained incrementally. Rebuilding it with ts_stat over the whole
      -- corpus is a sequential scan plus a hash aggregate over every lexeme; ~100 cheap upserts per
      -- inserted row costs nothing at a few thousand writes a day.
      CREATE OR REPLACE FUNCTION mem.accrue_corpus_stats() RETURNS trigger
      LANGUAGE plpgsql AS $ath$
      BEGIN
        IF NEW.tsv IS NOT NULL THEN
          INSERT INTO mem.lexeme_df (workspace_id, lexeme, df)
          SELECT NEW.workspace_id, u.lexeme, 1 FROM unnest(NEW.tsv) u
          ON CONFLICT (workspace_id, lexeme) DO UPDATE SET df = mem.lexeme_df.df + 1;
        END IF;
        INSERT INTO mem.corpus_stats (workspace_id, n_docs, sum_len)
        VALUES (NEW.workspace_id, 1, NEW.tsv_len)
        ON CONFLICT (workspace_id) DO UPDATE
          SET n_docs = mem.corpus_stats.n_docs + 1,
              sum_len = mem.corpus_stats.sum_len + EXCLUDED.sum_len;
        RETURN NULL;
      END $ath$;

      CREATE OR REPLACE TRIGGER t_mem_item_df AFTER INSERT ON mem.item
        FOR EACH ROW EXECUTE FUNCTION mem.accrue_corpus_stats();
      CREATE OR REPLACE TRIGGER t_mem_source_df AFTER INSERT ON mem.source
        FOR EACH ROW EXECUTE FUNCTION mem.accrue_corpus_stats();

      -- BM25F-lite: real IDF, real TF saturation, real length normalisation and field weights,
      -- none of which ts_rank has. It only ever runs over a candidate set bounded by a GIN probe.
      CREATE OR REPLACE FUNCTION mem.bm25(
        q_lex TEXT[], q_idf FLOAT8[], tsv TSVECTOR, doc_len INT, avg_len FLOAT8,
        k1 FLOAT8 DEFAULT 1.2, b FLOAT8 DEFAULT 0.75
      ) RETURNS FLOAT8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $ath$
        SELECT COALESCE(SUM(
            q_idf[array_position(q_lex, u.lexeme)]
            * (f.tf * (k1 + 1))
            / (f.tf + k1 * (1 - b + b * doc_len / NULLIF(avg_len, 0)))
        ), 0)
        FROM unnest(tsv) AS u
        CROSS JOIN LATERAL (
          SELECT COALESCE(array_length(u.positions, 1), 1)::float8
               * CASE WHEN 'A' = ANY(u.weights) THEN 3.0
                      WHEN 'B' = ANY(u.weights) THEN 2.0
                      WHEN 'C' = ANY(u.weights) THEN 1.5
                      ELSE 1.0 END AS tf
        ) AS f
        WHERE u.lexeme = ANY(q_lex);
      $ath$;

      -- Recency, trust and salience are not opinions about relevance, so they multiply the fused
      -- rank instead of joining it as ranking channels. The 0.35 decay floor keeps an old fact
      -- retrievable forever; the 0.12 factor keeps a retired fact findable for "what did I use
      -- before?" while making it essentially never win a present-tense query.
      --
      -- SUPERSEDED BY MIGRATION 75, which replaces the salience factor below: greatest(salience,0)
      -- here maps every negative salience onto the factor of a never-used row, so the half of the
      -- score a failure produces could not reach the ranking. Read the live body there.
      CREATE OR REPLACE FUNCTION mem.prior(
        kind mem.kind, trust mem.trust, valid_to TIMESTAMPTZ, observed_at TIMESTAMPTZ,
        salience REAL, pin BOOLEAN, t_now TIMESTAMPTZ, temporal_intent BOOLEAN
      ) RETURNS FLOAT8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $ath$
        SELECT
            (CASE trust WHEN 'stated' THEN 1.00 WHEN 'derived' THEN 0.85 ELSE 0.60 END)
          * (CASE WHEN valid_to IS NULL OR valid_to > t_now THEN 1.00
                  WHEN temporal_intent THEN 0.60 ELSE 0.12 END)
          * (0.35 + 0.65 * exp(-0.6931471805599453
                * extract(epoch FROM t_now - observed_at) / 86400.0
                / CASE kind WHEN 'source'    THEN 21.0
                            WHEN 'episode'   THEN 45.0
                            WHEN 'procedure' THEN 240.0
                            ELSE 1200.0 END))
          * (1.0 + 0.15 * ln(1 + greatest(salience, 0)))
          * (CASE WHEN pin THEN 1.6 ELSE 1.0 END);
      $ath$;

      CREATE INDEX IF NOT EXISTS mem_item_tsv_gin ON mem.item USING gin (tsv)
        WITH (fastupdate = off) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS mem_source_tsv_gin ON mem.source USING gin (tsv)
        WITH (fastupdate = on, gin_pending_list_limit = 2048) WHERE indexed;
      CREATE INDEX IF NOT EXISTS mem_item_trigram_gin ON mem.item USING gin (trigrams);
      CREATE INDEX IF NOT EXISTS mem_item_tags_gin ON mem.item USING gin (tags_hashed);
      CREATE INDEX IF NOT EXISTS mem_item_subject_idx
        ON mem.item (workspace_id, subject_key, predicate, valid_from DESC)
        WHERE kind = 'fact' AND status = 'active';
      -- One current value per functional predicate. The predicate's cardinality is materialised
      -- into pred_functional by the trigger because an index predicate may not contain a subquery.
      CREATE UNIQUE INDEX IF NOT EXISTS mem_fact_current_one
        ON mem.item (workspace_id, subject_key, predicate)
        WHERE kind = 'fact' AND status = 'active' AND valid_to IS NULL AND pred_functional;
      CREATE INDEX IF NOT EXISTS mem_item_kind_idx
        ON mem.item (workspace_id, kind, observed_at DESC) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS mem_item_pin_idx
        ON mem.item (workspace_id) WHERE pin AND status = 'active';
      CREATE INDEX IF NOT EXISTS mem_item_episode_idx
        ON mem.item (episode_id) WHERE episode_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS mem_source_task_idx
        ON mem.source (workspace_id, task_id, occurred_at);
      CREATE INDEX IF NOT EXISTS mem_source_episode_idx
        ON mem.source (episode_id, occurred_at);
      CREATE INDEX IF NOT EXISTS mem_source_origin_idx
        ON mem.source (workspace_id, origin_key, occurred_at DESC) WHERE origin_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS mem_link_dst_idx ON mem.link (dst_id, rel);
      CREATE INDEX IF NOT EXISTS mem_evidence_source_idx ON mem.evidence (source_id);
      CREATE INDEX IF NOT EXISTS mem_item_use_idx ON mem.item_use (item_id, used_at DESC);
      CREATE INDEX IF NOT EXISTS mem_fact_candidate_seen_idx
        ON mem.fact_candidate (workspace_id, last_seen);

      -- pgvector is strictly optional: without it these columns never exist and no query in the
      -- store references them, so the lexical floor is unaffected.
      DO $ath$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
          EXECUTE 'ALTER TABLE mem.item ADD COLUMN IF NOT EXISTS embedding halfvec(1024)';
          EXECUTE 'ALTER TABLE mem.source ADD COLUMN IF NOT EXISTS embedding halfvec(1024)';
          EXECUTE 'CREATE INDEX IF NOT EXISTS mem_item_vec_hnsw ON mem.item'
            || ' USING hnsw (embedding halfvec_cosine_ops)'
            || ' WITH (m = 16, ef_construction = 200)'
            || ' WHERE status = ''active'' AND embedding IS NOT NULL';
          EXECUTE 'CREATE INDEX IF NOT EXISTS mem_source_vec_hnsw ON mem.source'
            || ' USING hnsw (embedding halfvec_cosine_ops)'
            || ' WITH (m = 16, ef_construction = 200)'
            || ' WHERE embedding IS NOT NULL';
        END IF;
      END $ath$;
    `
  },
  {
    version: 36,
    name: 'real_currency_spend_caps',
    // A compute credit is a scheduling unit: the same nominal budget is cents on one model and
    // tens of dollars on another, so it can never answer "stop before this costs me more than X".
    // Provider cost per call was already being written to usage_entries.cost_usd and never read
    // back for anything that could halt work. These tables are what turns that column into a
    // ceiling: per-account daily and monthly caps, a per-task ceiling carried on the task itself,
    // and a once-per-window alert record so a soft threshold warns instead of nagging.
    sql: `
      CREATE TABLE IF NOT EXISTS spend_limits (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        daily_cap_usd DOUBLE PRECISION CHECK (daily_cap_usd IS NULL OR daily_cap_usd >= 0),
        monthly_cap_usd DOUBLE PRECISION CHECK (monthly_cap_usd IS NULL OR monthly_cap_usd >= 0),
        default_task_cap_usd DOUBLE PRECISION
          CHECK (default_task_cap_usd IS NULL OR default_task_cap_usd > 0),
        warn_at_percent INTEGER NOT NULL DEFAULT 80
          CHECK (warn_at_percent BETWEEN 1 AND 99),
        time_zone TEXT NOT NULL DEFAULT 'UTC',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- The primary key is the whole point: one row per window occurrence per level means an
      -- insert that changes nothing is how a caller learns it has already warned about this day.
      CREATE TABLE IF NOT EXISTS spend_alerts (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        window_name TEXT NOT NULL CHECK (window_name IN ('daily','monthly')),
        window_start TIMESTAMPTZ NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('warning','exceeded')),
        spent_usd DOUBLE PRECISION NOT NULL CHECK (spent_usd >= 0),
        cap_usd DOUBLE PRECISION NOT NULL CHECK (cap_usd >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, window_name, window_start, level)
      );
      CREATE INDEX IF NOT EXISTS spend_alerts_recent_idx
        ON spend_alerts(user_id, created_at DESC);

      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS max_spend_usd DOUBLE PRECISION
        CHECK (max_spend_usd IS NULL OR max_spend_usd > 0);
      ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS max_spend_usd DOUBLE PRECISION
        CHECK (max_spend_usd IS NULL OR max_spend_usd > 0);
      ALTER TABLE task_message_queue ADD COLUMN IF NOT EXISTS max_spend_usd DOUBLE PRECISION
        CHECK (max_spend_usd IS NULL OR max_spend_usd > 0);

      -- provider_ref is "<provider>:<model>" and was the only record of which model was billed.
      -- Splitting it once here means the per-model breakdown is a GROUP BY rather than a scan
      -- with string surgery in it, and rows written before this column existed keep their model.
      ALTER TABLE usage_entries ADD COLUMN IF NOT EXISTS model_id TEXT;
      UPDATE usage_entries SET model_id =
        substring(provider_ref FROM strpos(provider_ref, ':') + 1)
        WHERE model_id IS NULL AND provider_ref IS NOT NULL AND strpos(provider_ref, ':') > 0;

      -- Every spend query filters on real money changing hands, whatever it was spent on: model
      -- calls, media generation and anything added later all land in the same partial index.
      CREATE INDEX IF NOT EXISTS usage_entries_spend_idx
        ON usage_entries(user_id, created_at)
        WHERE state='settled' AND cost_usd > 0;
      CREATE INDEX IF NOT EXISTS usage_entries_task_spend_idx
        ON usage_entries(task_id, created_at)
        WHERE task_id IS NOT NULL AND state='settled' AND cost_usd > 0;
      -- Open tasks are what a start-time cap has to price in, and there are never many of them.
      CREATE INDEX IF NOT EXISTS tasks_open_spend_idx
        ON tasks(user_id)
        WHERE max_spend_usd IS NOT NULL
          AND status IN ('draft','queued','planning','running','awaiting_user',
                         'awaiting_resource','paused');
    `
  },
  {
    version: 37,
    name: 'memory_trigram_cardinality',
    // Jaccard bounds the two trigram set sizes against each other, so the stored set's cardinality
    // alone decides whether a row could ever clear the similarity threshold. Reading it off the
    // array meant detoasting every candidate just to find out, which is most of what the fuzzy
    // recall channel was paying for; materialising it makes that decision free.
    sql: `
      ALTER TABLE mem.item ADD COLUMN IF NOT EXISTS trigram_len INTEGER NOT NULL DEFAULT 0;

      CREATE OR REPLACE FUNCTION mem.index_row() RETURNS trigger LANGUAGE plpgsql AS $ath$
      BEGIN
        IF TG_TABLE_NAME = 'item' THEN
          IF NEW.indexed THEN
            NEW.tsv :=
                setweight(to_tsvector('simple', NEW.title_tokens), 'A')
             || setweight(to_tsvector('simple', NEW.tag_tokens), 'B')
             || setweight(to_tsvector('simple', NEW.body_tokens), 'D');
          ELSE
            NEW.tsv := NULL;
          END IF;
          NEW.pred_functional := NEW.predicate IS NOT NULL AND EXISTS (
            SELECT 1 FROM mem.predicate p
            WHERE p.name = NEW.predicate AND p.cardinality = 'one');
          NEW.trigram_len := COALESCE(cardinality(NEW.trigrams), 0);
        ELSE
          NEW.tsv := CASE WHEN NEW.indexed
            THEN setweight(to_tsvector('simple', NEW.body_tokens), 'D') ELSE NULL END;
        END IF;
        NEW.tsv_len := COALESCE(
          (SELECT SUM(COALESCE(array_length(positions, 1), 1)) FROM unnest(NEW.tsv)), 0)::int;
        RETURN NEW;
      END $ath$;

      CREATE OR REPLACE TRIGGER t_mem_item_index
        BEFORE INSERT OR UPDATE OF title_tokens, tag_tokens, body_tokens, predicate, indexed,
                                   trigrams
        ON mem.item FOR EACH ROW EXECUTE FUNCTION mem.index_row();

      UPDATE mem.item SET trigram_len = COALESCE(cardinality(trigrams), 0)
        WHERE trigram_len <> COALESCE(cardinality(trigrams), 0);
    `
  },
  {
    version: 38,
    name: 'turn_checkpoints_and_rewind_scope',
    // Editing a message has always made a new conversation path and left the computer exactly as
    // the agent left it - which reads, to an owner, as an undo that did not take. These are the
    // records behind the other half: one row per automatic checkpoint, so a point in the transcript
    // can be turned back into a point on the filesystem, and two columns on tasks so a fork says
    // which of the two it actually rewound. The bytes themselves live with the runner; this is the
    // index over them.
    //
    // workspace_snapshots is untouched. Those are the named recovery points the owner asks for and
    // keeps, and they answer a different question.
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_checkpoints (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        turn INTEGER NOT NULL DEFAULT 0,
        -- Where in the transcript this checkpoint sits, so "put the computer back to here" can be
        -- answered from a timeline position rather than by guessing from timestamps.
        event_sequence INTEGER,
        mechanism TEXT NOT NULL CHECK (mechanism IN ('btrfs','zfs','content')),
        -- Null under btrfs and ZFS: a filesystem snapshot is instant because it counts nothing.
        file_count INTEGER CHECK (file_count IS NULL OR file_count >= 0),
        total_bytes BIGINT CHECK (total_bytes IS NULL OR total_bytes >= 0),
        stored_bytes BIGINT NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
        duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS workspace_checkpoints_workspace_idx
        ON workspace_checkpoints(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS workspace_checkpoints_task_idx
        ON workspace_checkpoints(task_id, event_sequence DESC NULLS LAST)
        WHERE task_id IS NOT NULL;

      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rewind_scope TEXT
        CHECK (rewind_scope IN ('conversation','computer','both'));
      -- SET NULL rather than CASCADE: checkpoints are pruned on a retention policy, and losing the
      -- record of a fork because the point it came from was tidied away would be the wrong trade.
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS restored_checkpoint_id UUID
        REFERENCES workspace_checkpoints(id) ON DELETE SET NULL;
    `
  },
  {
    version: 39,
    name: 'notification_settings_and_spend_pause',
    // Notifications the owner can actually govern: which kinds reach a device, and when the box is
    // allowed to wake them. Deliberately no time zone column - quiet hours read the one already on
    // spend_limits, because a second copy of the owner's day is a second answer to "when does my
    // day roll over" and they will disagree.
    //
    // spend_paused_at is the only thing that tells a spend pause apart from an ordinary Pause. A
    // task the owner paused needs no notification; a task the box stopped because it reached a
    // ceiling is the one that is waiting for them and will wait forever unheard.
    sql: `
      CREATE TABLE IF NOT EXISTS notification_settings (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        approval_required BOOLEAN NOT NULL DEFAULT TRUE,
        task_finished BOOLEAN NOT NULL DEFAULT TRUE,
        spend_paused BOOLEAN NOT NULL DEFAULT TRUE,
        quiet_start_minute INTEGER CHECK (quiet_start_minute BETWEEN 0 AND 1439),
        quiet_end_minute INTEGER CHECK (quiet_end_minute BETWEEN 0 AND 1439),
        quiet_allow_approvals BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_kind_check;
      ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_kind_check
        CHECK (kind IN ('approval_required','task_finished','spend_paused'));

      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS spend_paused_at TIMESTAMPTZ;
    `
  },
  {
    version: 40,
    name: 'conversation_shelf_and_title_source',
    // The sidebar is the owner's memory of what they have been doing, and it needs three things
    // this table could not answer.
    //
    // title_source records who named a conversation. The first ten words of the prompt is a
    // placeholder, not a name, and it is the only value a generated title may overwrite: once the
    // owner has renamed a conversation, or the box has read the first exchange and titled it, that
    // name is theirs and nothing rewrites it.
    //
    // pinned and archived_at are the two ways a conversation leaves the flow of recency without
    // being destroyed. archived_at is a timestamp rather than a flag so "recently archived" can be
    // shown and an undo can name what it is undoing.
    //
    // The index carries the sidebar's exact ordering, including the GREATEST() expression, so the
    // owner's first page never sorts the whole table.
    sql: `
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title_source TEXT NOT NULL DEFAULT 'prompt';
      ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_title_source_check;
      ALTER TABLE tasks ADD CONSTRAINT tasks_title_source_check
        CHECK (title_source IN ('prompt','generated','owner'));
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS tasks_activity_idx
        ON tasks(user_id, pinned DESC, GREATEST(updated_at, created_at) DESC, id DESC);
      -- A conversation still wearing its placeholder name is a small and shrinking set, so the
      -- titler finds its work without reading the owner's whole history.
      CREATE INDEX IF NOT EXISTS tasks_untitled_idx
        ON tasks(created_at DESC) WHERE title_source = 'prompt';
    `
  },
  {
    version: 41,
    name: 'drop_unreached_tables',
    // Six tables no code reads and no code writes. Each was created for something the product
    // decided against, and each has been carried by every install since - through every backup,
    // every restore and every schema dump - as a row of columns describing a feature that is not
    // there.
    //
    //   capability_grants   - capability tokens are signed and stateless; nothing was ever granted.
    //   browser_leases      - the browser holder lives with the runner that enforces it.
    //   idempotency_records - superseded by api_operations, which is the table the API actually
    //                         writes. The only statement that still named this one was a DELETE in
    //                         the five-minute maintenance sweep, deleting from an empty table.
    //   webhook_events      - billing webhook de-duplication, for billing this product does not do.
    //   workspace_orders    - a checkout and payment flow, in a program the owner runs themselves.
    //   key_release_receipts- attestation receipts for a key-release service that is not deployed.
    //
    // Every one is empty on every install, because nothing has ever inserted into any of them, so
    // this drops no owner data. They are dropped rather than left in place because a schema is
    // documentation: a table called workspace_orders says this program takes payments.
    sql: `
      DROP TABLE IF EXISTS capability_grants;
      DROP TABLE IF EXISTS browser_leases;
      DROP TABLE IF EXISTS idempotency_records;
      DROP TABLE IF EXISTS webhook_events;
      DROP TABLE IF EXISTS workspace_orders;
      DROP TABLE IF EXISTS key_release_receipts;
    `
  },
  {
    version: 42,
    name: 'previews_expire_from_disuse',
    // expires_at on the private link to an app running on the owner's own computer measures how
    // long the link has left if nobody opens it. A countdown started at creation and capped at 24
    // hours would leave the owner's phone unable to open it the next morning, with publishing to
    // the public internet the only thing that did not expire. Every request through the preview
    // gateway pushes it back out, so a preview in use never lapses, and one nobody has touched for
    // a month closes rather than leaving a bearer token live in a chat history forever.
    //
    // Live private previews are given the full idle window here rather than being left on whatever
    // remains of a countdown from creation, which for most of them is minutes. Ones that had
    // already lapsed stay lapsed: this restores nothing the owner has already lost.
    sql: `
      UPDATE workspace_previews SET expires_at = NOW() + INTERVAL '30 days', updated_at = NOW()
       WHERE status = 'active' AND visibility = 'private'
         AND (expires_at IS NULL OR expires_at > NOW());
      CREATE INDEX IF NOT EXISTS workspace_previews_idle_idx
        ON workspace_previews(expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;
    `
  },
  {
    version: 43,
    name: 'agent_raised_notifications',
    // Every push this box could send was derived from a state change it happened to notice, so the
    // one message worth sending - "the page you asked me to watch changed" - had no way to exist,
    // and the messages nobody asked for fired on a timer. This table is the agent's own half: one
    // row per notification it decided to raise, with the sentence encrypted under the workspace key
    // exactly like a conversation title, because what the agent has to say about the owner's work
    // is the owner's business and the notifier holds no key.
    //
    // resource_id in the delivery ledger is this row's id, so each raised notification reaches each
    // subscribed device once and stays delivered.
    sql: `
      CREATE TABLE IF NOT EXISTS agent_notifications (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('agent_message','takeover_needed')),
        message_ciphertext JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS agent_notifications_task_idx
        ON agent_notifications(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS agent_notifications_user_idx
        ON agent_notifications(user_id, created_at DESC);

      ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_kind_check;
      ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_kind_check
        CHECK (kind IN ('approval_required','task_finished','spend_paused',
                        'agent_message','takeover_needed'));
    `
  },
  {
    version: 44,
    name: 'drop_workspace_shape_and_user_plan',
    // Two columns that decided things this product does not decide.
    //
    // workspaces.shape was a four-value enum - light, standard, heavy, analysis - written on
    // creation, validated on two routes, gated by a plan and by an organisation policy, and sent to
    // the runner in the provisioning body. The runner never read it, and neither did the worker,
    // the resource paths or the client: there is one computer, it is the machine the owner
    // installed this on, and no value of this column ever changed anything about it.
    //
    // users.plan_id defaulted to 'community' and nothing could ever set it to anything else, but
    // every ceiling on the box was looked up through it with a fallback. A row carrying any other
    // string - a restored backup, a hand-edited table - would have quietly applied a stranger's
    // limits to the owner's own machine. subscriptions.plan_id stays: usage has to accrue against
    // a named period, and that is the column that names it.
    sql: `
      ALTER TABLE workspaces DROP COLUMN IF EXISTS shape;
      ALTER TABLE users DROP COLUMN IF EXISTS plan_id;
    `
  },
  {
    version: 45,
    name: 'drop_gpu_tier_and_payment_reference',
    // The same defect as workspaces.shape, twice more.
    //
    // gpu_tier was four values - off, boost, pro, ultra - written on creation, re-validated on
    // resize, and refused unless an installer flag was on. The runner is never told which one was
    // chosen, so nothing about the machine changes: three of the four are names for "on" and none
    // of them turns anything on. GPU passthrough on the owner's own hardware is a property of how
    // they installed this, not a tier they subscribe to.
    //
    // users.payment_customer_ref has never been written by any code in this repository. It is a
    // payment-processor customer id, in a program the owner runs on their own machine.
    sql: `
      ALTER TABLE workspaces DROP COLUMN IF EXISTS gpu_tier;
      ALTER TABLE users DROP COLUMN IF EXISTS payment_customer_ref;
    `
  },
  {
    version: 46,
    name: 'drop_organizations',
    // garden is one person's computer. There is one account on it, it holds the keys to its own
    // workspace, and every screen in the product is written for that person - so a subsystem for
    // sharing a workspace with colleagues under a policy an administrator sets was never a feature
    // this product could finish. What it was instead was a second answer to "who may do this",
    // sitting underneath every read in the store as a pair of LEFT JOINs, and a policy object that
    // could refuse a privacy route, a credit ceiling, a connector or a public preview on the
    // owner's own machine.
    //
    //   organizations          - the group, its owner and its policy.
    //   organization_members   - who else was in it, at which of four roles.
    //   organization_workspaces- which computers the group could reach.
    //   organization_audit_events - who did what to the group.
    //
    // The rows are dropped, not migrated: nothing that reads them survives this release, and on a
    // single-owner install the membership row for the owner's own workspaces adds no access their
    // user_id did not already give them. workspaces.user_id is now the whole of the answer.
    //
    // subscriptions.external_ref goes in the same statement because it is the last of the
    // payment-processor columns: a reference to a customer record at a billing provider, in a
    // program the owner installed on their own hardware. Nothing has ever written it.
    sql: `
      DROP TABLE IF EXISTS organization_audit_events;
      DROP TABLE IF EXISTS organization_workspaces;
      DROP TABLE IF EXISTS organization_members;
      DROP TABLE IF EXISTS organizations;
      ALTER TABLE subscriptions DROP COLUMN IF EXISTS external_ref;
    `
  },
  {
    version: 47,
    name: 'mail_and_calendar_connector_kinds',
    // The two kinds the connector layer now speaks. A mailbox is reached over IMAP and SMTP and a
    // calendar over CalDAV, neither of which is an HTTPS API, which is why the column had to be
    // told about them rather than just the contract enum.
    sql: `
      ALTER TABLE connectors DROP CONSTRAINT IF EXISTS connectors_kind_check;
      ALTER TABLE connectors ADD CONSTRAINT connectors_kind_check
        CHECK (kind IN ('github','webdav','mcp_http','imap','caldav'));
    `
  },
  {
    version: 48,
    name: 'notification_switches_for_agent_raised_kinds',
    // The two kinds the agent raises arrived with no switch, on the reasoning that the agent asking
    // for the owner is not the same as the box reporting on itself. In practice that means the one
    // notification the owner explicitly asked for - "tell me when this changes" - is also the only
    // one they cannot turn down, and an agent that decides everything is worth saying can only be
    // silenced by revoking the device. Both default to TRUE, so nothing an install already does
    // changes; what changes is that there is a way to stop it.
    sql: `
      ALTER TABLE notification_settings
        ADD COLUMN IF NOT EXISTS agent_message BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE notification_settings
        ADD COLUMN IF NOT EXISTS takeover_needed BOOLEAN NOT NULL DEFAULT TRUE;
    `
  },
  {
    version: 49,
    name: 'drop_subscription_allowance',
    // The last of the hosted shape. `subscriptions` held one row per owner carrying a plan id that
    // could only ever be 'community', a status that was always 'active', an included allowance of a
    // billion credits and an overage limit of zero - and a billing period that was written when the
    // row was created and never advanced again, so usage accrued against the month of the install
    // for as long as the box lived. Two gates read it: a compute-credit ceiling no real value could
    // reach, and an "is the subscription active" check on scheduled runs that could only fail if
    // the row were missing. What actually stops a runaway is the owner's own spend cap, in the
    // currency the provider bills, which is checked in the same statement and stays.
    //
    // The index goes with it. It was named for a managed AI service and covered one query - what
    // the usage pane calls provider spend - which now asks the same question the spending caps ask,
    // through the same statement they use. Nothing filters on the kind any more, and the general
    // usage_user_period_idx serves what is left, so a partial index on a predicate no query writes
    // is only a write cost.
    sql: `
      DROP TABLE IF EXISTS subscriptions;
      DROP INDEX IF EXISTS usage_managed_ai_window_idx;
    `
  },
  {
    version: 50,
    name: 'drop_terms_acceptance_and_provider_connections',
    // Two more pieces of the hosted shape, both of them halves.
    //
    // The legal columns recorded that an owner had accepted a versioned document. Nothing served a
    // document to accept: the route that would have said one was outstanding answered a hardcoded
    // "nothing is outstanding", the version setting was read in exactly one place - to copy it into
    // the row at registration - and the method that would have recorded a later acceptance was
    // never called. An owner installing AGPL software on their own machine is not presented with
    // terms by that machine, so this is removed rather than finished.
    //
    // provider_connections predates managed_provider_credentials, which is where the inference
    // credential has lived since the provider settings screen was written. Nothing has inserted a
    // row here in the life of the current code - the four store methods that read and wrote it had
    // no caller anywhere - so what remained was a table carrying an encrypted secret and a
    // terms_accepted_at column, which a backup faithfully copied and a restore faithfully restored.
    sql: `
      ALTER TABLE users DROP COLUMN IF EXISTS legal_documents_version;
      ALTER TABLE users DROP COLUMN IF EXISTS legal_accepted_at;
      DROP TABLE IF EXISTS provider_connections;
    `
  },
  {
    version: 51,
    name: 'drop_columns_no_code_writes',
    // Five columns that were declared and never written, and one CHECK that allowed a value nothing
    // can produce. A column carrying a default nobody updates is worse than a missing one: it is
    // served on every response as a number that looks measured.
    //
    // tasks.reserved_compute_credits was read into every task record and served on every task, and
    // no statement anywhere set it, so every task reported a reservation of zero. What is actually
    // reserved lives in usage_entries with state='reserved', which is where the usage summary's
    // reservedCredits already comes from - one place, in the currency the provider bills.
    //
    // workspaces.last_active_at promises the thing touchWorkspace does not do: it sets updated_at.
    // workspace_keys.key_version and rotated_at were the schema half of key rotation; the code half
    // was never written, and a version column that is always 1 tells a reader rotation happened.
    //
    // wrapping_mode's 'attested' arm belonged to hardware key release, whose receipts table
    // migration 41 already dropped. packages/core mints 'hosted' and nothing else can reach here.
    //
    // workspace_previews.hosting_mode stored a choice between an always-awake site and one that
    // idles, and neither half exists: nothing in this codebase hibernates a workspace on its own
    // and nothing holds one awake. The one place it was read inverted the promise - the mode sold
    // as "always on" was the only one that refused to wake a sleeping box. Publishing now means one
    // thing, so the gateway wakes the computer for any live preview and the column goes.
    sql: `
      ALTER TABLE tasks DROP COLUMN IF EXISTS reserved_compute_credits;
      ALTER TABLE workspaces DROP COLUMN IF EXISTS last_active_at;
      ALTER TABLE workspace_keys DROP COLUMN IF EXISTS key_version;
      ALTER TABLE workspace_keys DROP COLUMN IF EXISTS rotated_at;
      ALTER TABLE workspace_previews DROP COLUMN IF EXISTS hosting_mode;
      UPDATE workspace_keys SET wrapping_mode='hosted' WHERE wrapping_mode <> 'hosted';
      ALTER TABLE workspace_keys DROP CONSTRAINT IF EXISTS workspace_keys_wrapping_mode_check;
      ALTER TABLE workspace_keys
        ADD CONSTRAINT workspace_keys_wrapping_mode_check CHECK (wrapping_mode = 'hosted');
    `
  },
  {
    version: 52,
    name: 'memory_alias_surface',
    // A fourth weighted field on mem.item, carrying the component words of the entry's compound
    // terms: the parts of its subject, object, title, tags and the identifiers in its body.
    //
    // The tokenizer keeps `garden-relay`, `imap_idle_notify_interval` and `/srv/garden/var/log`
    // whole on purpose - shredding them is how a stemmer destroys the substance of an agent
    // computer's memory. The cost was that a fact whose subject is `garden-relay` shared no lexeme
    // with "what port does the relay listen on": not a low rank, no channel at all. The lexical
    // channel could not reach it, the structural channel matches subject keys by exact equality so
    // `relay` was not `garden-relay`, and the fuzzy channel is built from identifier-shaped query
    // terms, of which a plain-English question has none. A fact about a named service was
    // unretrievable by the name people use for it.
    //
    // C weight sits below the title (A) and tags (B) and above the body (D), which is the right
    // order: an entry actually titled "relay" should still win over one that merely contains a
    // compound with `relay` in it. The column is populated by `buildMemoryItemIndex`, so it is
    // keyed exactly like every other token here and PostgreSQL still cannot read any of it.
    //
    // Rows written before this migration keep an empty alias field until they are rewritten; the
    // index key lives in the worker, so no backfill is possible from inside the database.
    sql: `
      ALTER TABLE mem.item ADD COLUMN IF NOT EXISTS alias_tokens TEXT NOT NULL DEFAULT '';

      CREATE OR REPLACE FUNCTION mem.index_row() RETURNS trigger LANGUAGE plpgsql AS $ath$
      BEGIN
        IF TG_TABLE_NAME = 'item' THEN
          IF NEW.indexed THEN
            NEW.tsv :=
                setweight(to_tsvector('simple', NEW.title_tokens), 'A')
             || setweight(to_tsvector('simple', NEW.tag_tokens), 'B')
             || setweight(to_tsvector('simple', NEW.alias_tokens), 'C')
             || setweight(to_tsvector('simple', NEW.body_tokens), 'D');
          ELSE
            NEW.tsv := NULL;
          END IF;
          NEW.pred_functional := NEW.predicate IS NOT NULL AND EXISTS (
            SELECT 1 FROM mem.predicate p
            WHERE p.name = NEW.predicate AND p.cardinality = 'one');
          NEW.trigram_len := COALESCE(cardinality(NEW.trigrams), 0);
        ELSE
          NEW.tsv := CASE WHEN NEW.indexed
            THEN setweight(to_tsvector('simple', NEW.body_tokens), 'D') ELSE NULL END;
        END IF;
        NEW.tsv_len := COALESCE(
          (SELECT SUM(COALESCE(array_length(positions, 1), 1)) FROM unnest(NEW.tsv)), 0)::int;
        RETURN NEW;
      END $ath$;

      CREATE OR REPLACE TRIGGER t_mem_item_index
        BEFORE INSERT OR UPDATE OF
          title_tokens, tag_tokens, alias_tokens, body_tokens, trigrams, predicate, indexed
        ON mem.item FOR EACH ROW EXECUTE FUNCTION mem.index_row();
    `
  },
  {
    version: 53,
    name: 'checkpoint_order_taken',
    // Which of two checkpoints was taken first, as a fact rather than an inference.
    //
    // A turn that checkpoints twice before writing an event produces two rows carrying the same
    // event_sequence, and only the earlier one sits in front of all the work at that position -
    // the later one already contains the changes an undo is being asked to drop. That order was
    // read from created_at, which is NOW(): transaction start time, at whatever resolution the
    // clock and the transaction boundaries happen to give. When two rows tie, the ordering falls
    // through to the identifier, and a UUID says nothing about when it was made - so the undo can
    // restore the wrong checkpoint, silently, and only on a machine that has been lived in.
    //
    // A sequence cannot tie. The backfill orders existing rows the way the old query read them, so
    // no installation changes its answer for a checkpoint it already has.
    sql: `
      ALTER TABLE workspace_checkpoints
        ADD COLUMN IF NOT EXISTS taken_seq BIGINT;

      CREATE SEQUENCE IF NOT EXISTS workspace_checkpoints_taken_seq
        OWNED BY workspace_checkpoints.taken_seq;

      UPDATE workspace_checkpoints c
        SET taken_seq = ordered.rank
        FROM (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rank
          FROM workspace_checkpoints
        ) ordered
        WHERE c.id = ordered.id AND c.taken_seq IS NULL;

      SELECT setval(
        'workspace_checkpoints_taken_seq',
        GREATEST((SELECT COALESCE(MAX(taken_seq), 0) FROM workspace_checkpoints), 1));

      ALTER TABLE workspace_checkpoints
        ALTER COLUMN taken_seq SET DEFAULT nextval('workspace_checkpoints_taken_seq');

      UPDATE workspace_checkpoints SET taken_seq = nextval('workspace_checkpoints_taken_seq')
        WHERE taken_seq IS NULL;

      ALTER TABLE workspace_checkpoints ALTER COLUMN taken_seq SET NOT NULL;

      CREATE INDEX IF NOT EXISTS workspace_checkpoints_undo_idx
        ON workspace_checkpoints(task_id, event_sequence DESC, taken_seq ASC);
    `
  },
  {
    version: 54,
    name: 'drop_unused_memory_embeddings',
    // Removes the semantic channel that was never built.
    //
    // Migration 35 created halfvec(1024) columns on mem.item and mem.source, two partial HNSW
    // indexes over them, and an embed_state enum to sequence a queue that does not exist. Nothing
    // has ever written a vector and no query has ever read one, so what shipped was an index of
    // nothing, a state machine with one state, and a memoryCapabilities() flag reporting a channel
    // the retrieval query has no branch for. That is worse than not having it: it reads as a
    // component the main path depends on, and every later change to recall has to be explained
    // against a surface that contributes nothing.
    //
    // Finishing it is not a question of where to get vectors. Memory bodies are sealed before they
    // reach PostgreSQL and are searchable only through a keyed blind index, built in
    // packages/core/src/memory.ts, so the database never holds the plaintext. An embedding is a
    // dense derivative of that same plaintext, close enough that the text can be reconstructed from
    // the vector, and it has to sit unencrypted beside the ciphertext to be searchable at all -
    // which hands anything with read access on the database a recoverable copy of exactly the text
    // the encryption is there to hide. It does not matter what produced the vector, which is what
    // makes this the objection that decides it. The two costs easier to reach for do not decide
    // anything: an embedding API puts a second vendor on the write path, which garden's rule
    // against third-party SaaS on a core path forbids, and a local model is a new runtime
    // dependency with a download behind it - both true, but a model running on this computer
    // answers the first outright, and the second is a price rather than a reason.
    //
    // What the channel would have bought - reaching a stored row from a paraphrase that shares none
    // of its words - is therefore not bought at all. The agent asking its own memory a question in
    // its own words (`recallMemory` in apps/worker/src/memory-runtime.ts) narrows that rather than
    // closing it: the pack a task opens with is built before the agent has said anything. The gap
    // is the price of the encryption, and it is carried as a probe the memory eval asserts still
    // misses (packages/data/src/memory-eval.ts) rather than being talked out of existence here.
    //
    // The column drops are guarded because they only exist where pgvector was installed. The
    // extension itself is left alone: this migration removes what garden put in the database, and
    // an extension the owner may be using elsewhere is not garden's to withdraw.
    sql: `
      DROP INDEX IF EXISTS mem.mem_item_vec_hnsw;
      DROP INDEX IF EXISTS mem.mem_source_vec_hnsw;

      ALTER TABLE mem.item DROP COLUMN IF EXISTS embedding;
      ALTER TABLE mem.source DROP COLUMN IF EXISTS embedding;
      ALTER TABLE mem.item DROP COLUMN IF EXISTS embed_state;
      ALTER TABLE mem.source DROP COLUMN IF EXISTS embed_state;

      DROP TYPE IF EXISTS mem.embed_state;
    `
  },
  {
    version: 55,
    name: 'checkpoint_anchors_its_turn',
    // Re-points existing undo points at the message whose turn they hold.
    //
    // A checkpoint recorded the transcript position at the moment it was taken, which is always
    // after the message that started the turn and after the status lines that follow it. But what
    // the checkpoint holds is the computer as it was BEFORE that turn did anything. Rewinding
    // resolves on `event_sequence <= the message you picked`, so picking the message you sent -
    // which is what the client offers - could never match the undo point for the work that message
    // caused. On a first turn the owner was told the computer could not be put back at all; on a
    // later one they silently got the previous turn's point, which throws away a turn they never
    // asked to undo.
    //
    // Each row moves back to the last user message at or before where it was taken, which is the
    // opening of its own turn. Rows with no user message before them - a scheduled run, which
    // starts without one - keep the number they have.
    sql: `
      UPDATE workspace_checkpoints c
      SET event_sequence = COALESCE(
        (SELECT MAX(e.sequence) FROM task_events e
          WHERE e.task_id = c.task_id AND e.kind = 'user_message'
            AND e.sequence <= c.event_sequence),
        c.event_sequence)
      WHERE c.task_id IS NOT NULL AND c.event_sequence IS NOT NULL;
    `
  },
  {
    version: 56,
    name: 'generated_media_is_not_a_queue',
    // Drops the media job queue, because generation is now part of the call that asks for it.
    //
    // The queue never bought asynchrony. The agent had to poll a `media_status` tool, which slept
    // inside the turn until the row changed, so the turn blocked either way; what the queue added
    // was a second service, a second runner client, two encrypted columns and a spend check that
    // had to sum every unfinished row because none of them had reached the ledger yet. An image
    // takes about ten seconds on a computer where a shell command may take an hour.
    //
    // Nothing is lost with the table. The generated files are in the workspace where they were
    // written, and what each generation cost is in usage_entries, which is where the owner's
    // spending was always read from.
    sql: `DROP TABLE IF EXISTS media_jobs;`
  },
  {
    version: 57,
    name: 'deleting_a_conversation_takes_its_memory_with_it',
    // Deleting a task removed its events, its plans and its approvals, and left every memory row
    // the same conversation had produced: the episode, and - worse - the chunks of the owner's own
    // words held verbatim in mem.source. On a computer that offers to keep no logs, "delete this
    // conversation" has to mean it, and the only version of that which cannot be forgotten by a
    // later caller is one the schema enforces.
    //
    // Only the episode and its sources carry task_id. A promoted fact does not, deliberately: it is
    // something the owner stated on more than one day, distilled away from any single conversation,
    // so it survives the deletion of the one that happened to observe it.
    //
    // Existing orphans are removed rather than detached. A row whose task no longer exists is
    // memory of a conversation the owner has already deleted, and keeping it would defeat the
    // deletion.
    sql: `
      DELETE FROM mem.source WHERE task_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = mem.source.task_id);
      DELETE FROM mem.item WHERE task_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = mem.item.task_id);
      ALTER TABLE mem.item DROP CONSTRAINT IF EXISTS mem_item_task_id_fkey;
      ALTER TABLE mem.item ADD CONSTRAINT mem_item_task_id_fkey
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;
      ALTER TABLE mem.source DROP CONSTRAINT IF EXISTS mem_source_task_id_fkey;
      ALTER TABLE mem.source ADD CONSTRAINT mem_source_task_id_fkey
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;
    `
  },
  {
    version: 58,
    name: 'a_correction_can_reach_a_running_task',
    // A message sent while a task was working could only wait for it to stop. If the agent had
    // misread the request, or the owner changed their mind, or it was heading down a road they
    // could see was wrong, the only options were to watch it finish or cancel the whole turn and
    // lose the work. The one channel for steering was the one that could not be used while there
    // was anything to steer.
    //
    // The column marks a message the owner wants applied now rather than after: the running turn
    // picks it up at its next step boundary and carries on with it, keeping everything already
    // done. Queue-for-later stays the default, because "do this next" and "no, not that" are
    // genuinely different intentions and guessing between them from timing alone would get it
    // wrong in whichever direction the guess was made.
    sql: `
      ALTER TABLE task_message_queue
        ADD COLUMN IF NOT EXISTS interrupt BOOLEAN NOT NULL DEFAULT FALSE;
    `
  },
  {
    version: 59,
    name: 'choices_follow_the_owner_not_the_device',
    // The owner's choices lived in localStorage, so they were facts about a browser rather than
    // about the person. Pick a model on the laptop and the phone still offers the old one; the two
    // devices disagree about a setting the owner set once, and neither is wrong from where it sits.
    // On a computer whose whole point is being the same computer from anywhere, a setting that does
    // not travel is a setting that is not really set.
    //
    // JSONB rather than a column per choice: these are small, they are read together in one
    // bootstrap, and adding the next one should not be a migration. The shape is validated on the
    // way in and again on the way out, so a row written by a newer build cannot break an older one.
    sql: `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
    `
  },
  {
    version: 60,
    name: 'a_half_typed_message_follows_the_owner',
    // The draft lived in localStorage, which made "close the laptop, pick it up on the phone" - the
    // sentence the client's own storage module gives as its reason for existing - true only if both
    // happened on the same device. Start a message on the laptop and the phone shows an empty box.
    //
    // Encrypted with the workspace key like every other thing the owner wrote, because that is what
    // it is: their words, not a setting. One row per conversation, plus one for the message not yet
    // attached to a conversation, which is where most first sentences are typed.
    sql: `
      CREATE TABLE IF NOT EXISTS message_drafts (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        -- NULL is the draft for a conversation that does not exist yet. The unique index below
        -- cannot enforce that on its own, because NULLs are never equal to one another in SQL.
        task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
        body_ciphertext JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS message_drafts_task_idx
        ON message_drafts(workspace_id, task_id) WHERE task_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS message_drafts_new_idx
        ON message_drafts(workspace_id) WHERE task_id IS NULL;
    `
  },
  {
    version: 61,
    name: 'a_preview_opens_on_the_thing_it_published',
    // A preview is a port, and the owner lands on that port's root. Asked to build a page and
    // publish a link, an agent starts a file server on the workspace and publishes it - so the
    // link opens on an index of every file in there, and the page it just wrote sits one path away.
    // Telling the model about it in the tool description was tried first and did not take.
    //
    // Nullable, because a preview of an app that really does serve its own root wants no path at
    // all, and every preview published before this has none.
    sql: `
      ALTER TABLE workspace_previews
        ADD COLUMN IF NOT EXISTS entry_path TEXT;
    `
  },
  {
    version: 62,
    name: 'a_scheduled_run_says_where_it_came_from',
    // A materialised run was indistinguishable from a conversation the owner started. The only
    // record that a task came from a schedule was a row in task_schedule_runs, which the task read
    // never joins - so the sidebar, which orders by recency alone, interleaved a fifteen-minute
    // watcher's ninety-six runs a day with the owner's own work and buried it. The column is what
    // lets the list collapse a run of them into one line.
    //
    // Deliberately not a foreign key. Neither action Postgres offers is right here: CASCADE would
    // delete the owner's conversations when they turn a watcher off, and SET NULL would spill every
    // past run back into the sidebar as a separate line at exactly that moment - the burying this
    // column exists to stop, triggered by tidying up. What is recorded is provenance: this
    // conversation was minted by that schedule, which does not stop being true when the schedule is
    // deleted. Clients name the group from the runs themselves, so nothing downstream needs the
    // schedule row to still exist.
    //
    // Safe on a live box: a nullable column with no default is a catalogue change in Postgres 11
    // and later, so no table rewrite and no long lock. The backfill reads task_schedule_runs, which
    // has carried the pairing since version 11, so every run already on the box groups on the first
    // load after the update rather than only new ones. The index is partial because the owner's own
    // conversations are the overwhelming majority of the table and none of them are in it.
    sql: `
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS schedule_id UUID;

      UPDATE tasks t SET schedule_id = r.schedule_id
      FROM task_schedule_runs r
      WHERE r.task_id = t.id AND t.schedule_id IS NULL;

      CREATE INDEX IF NOT EXISTS tasks_schedule_idx
        ON tasks(schedule_id, created_at DESC)
        WHERE schedule_id IS NOT NULL;
    `
  },
  {
    version: 63,
    name: 'a_conversation_is_findable_by_its_name_at_any_age',
    // A conversation's name is encrypted, so there was no predicate that could match it and search
    // matched it by decrypting the newest few hundred instead. That is fine for a conversation
    // named after its opening request, because the request itself is in the blind-indexed corpus
    // and reachable however old it is. It is not fine for one the owner renamed: their words were
    // never in the request, so past the decrypt window the name existed nowhere a query could
    // reach, and the share of the box that was past the window grew every month it was owned.
    //
    // The corpus already solves this and the solution is reused rather than rebuilt: the tokenizer
    // runs in the application, every lexeme becomes a keyed HMAC, and PostgreSQL matches a token
    // space it cannot read back. `name_tsv` is that vector for the conversation's own name at A
    // weight and the opening of its request at D, so "named that" outranks "asked about that" and
    // both are one GIN probe.
    //
    // NULL rather than an empty vector for a row nobody has indexed yet, because the two need to be
    // told apart: a conversation whose name is entirely stop words indexes to nothing and is done,
    // while one written before this column existed has to be read and sealed again. The API does
    // that on the boot after the update, beside the other backfills, and NULL is what it looks for
    // - so a backfill interrupted half way resumes rather than starting over.
    sql: `
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS name_tsv TSVECTOR;

      CREATE INDEX IF NOT EXISTS tasks_name_tsv_gin ON tasks USING gin (name_tsv)
        WITH (fastupdate = off) WHERE name_tsv IS NOT NULL;
    `
  },
  {
    version: 64,
    name: 'the_workspace_says_who_is_inside_it',
    // One agent per workspace was enforced by asking the tasks table whether any other task in the
    // workspace held a live lease. Under READ COMMITTED that question is answered from a snapshot,
    // and the snapshot outlives a competitor's commit by exactly as long as the competitor's lock
    // does - so two polls a millisecond apart could both read a free workspace and both take a
    // task in it. No arrangement of that query closes the gap, because the lock that would make
    // the second wait is released at precisely the moment its snapshot stops being stale.
    //
    // Recording the hold on the workspace row turns the question into a predicate on the row being
    // locked, which is the one thing PostgreSQL will re-check for you: a writer that finds the row
    // updated under it re-evaluates its WHERE against the version the competitor committed, and
    // the loser matches nothing.
    //
    // The expiry beside it is the part that matters most. A hold nothing can clear would wedge the
    // workspace forever, which is far worse than the race it replaces, so the hold carries the same
    // deadline as the task lease written in the same statement: a worker that dies holding both
    // lets go of both at the same instant, with nobody to run the sweep that would have done it.
    // The trigger is the second, faster path - it hands the workspace back the moment the task
    // stops holding a live lease, however the task got there, so no future caller has to remember.
    //
    // Every incomplete state reads as free, deliberately and in that order: a null holder, a null
    // deadline, a deadline in the past. The foreign key nulls the holder when a conversation is
    // deleted, which leaves exactly one of those states behind, and it is the harmless one.
    //
    // Safe on a live box: two nullable columns with no default are a catalogue change, and the
    // foreign key validates against a table where every value is still NULL.
    sql: `
      ALTER TABLE workspaces
        ADD COLUMN IF NOT EXISTS lease_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

      CREATE OR REPLACE FUNCTION release_workspace_hold() RETURNS trigger
      LANGUAGE plpgsql AS $ath$
      BEGIN
        UPDATE workspaces SET lease_task_id = NULL, lease_expires_at = NULL
        WHERE id = NEW.workspace_id AND lease_task_id = NEW.id;
        RETURN NULL;
      END $ath$;

      -- Narrow on purpose, because tasks are written several times a step. The column list means
      -- a write that does not mention the lease never considers this at all, and the condition
      -- means a turn that is still running - by far the common case - stops at a boolean.
      --
      -- It reaches the workspace holding the task, which is the order every statement here that
      -- can wait already takes those two rows in. The one that takes them the other way round is
      -- the lease itself, and it waits on nothing, so there is no cycle to close.
      CREATE OR REPLACE TRIGGER t_workspace_hold_release
        AFTER UPDATE OF lease_owner, lease_expires_at ON tasks
        FOR EACH ROW
        WHEN (OLD.lease_expires_at IS NOT NULL
              AND (NEW.lease_expires_at IS NULL OR NEW.lease_expires_at <= NOW()))
        EXECUTE FUNCTION release_workspace_hold();
    `
  },
  {
    version: 65,
    name: 'a_message_the_conversation_can_no_longer_deliver',
    // A queued message had three ends: it ran, the owner stopped the conversation, or it waited.
    // Waiting was the only one available to a turn that died, so a correction sent to a task that
    // then failed for good stayed 'queued' on a task nothing would ever lease again - and the count
    // the header reads off this column went on telling the owner a message was on its way.
    //
    // 'undelivered' is that fourth end, and it is deliberately not 'cancelled': the owner cancelling
    // and garden running out of attempts are different events, and the row is the only place that
    // difference survives once the timeline has scrolled.
    //
    // Safe on a live box: a constraint swap on a table whose every existing row already satisfies
    // the wider check, and the partial index the queue is read through is defined on 'queued'.
    sql: `
      ALTER TABLE task_message_queue DROP CONSTRAINT IF EXISTS task_message_queue_status_check;
      ALTER TABLE task_message_queue ADD CONSTRAINT task_message_queue_status_check
        CHECK (status IN ('queued','promoted','cancelled','undelivered'));
    `
  },
  {
    version: 66,
    name: 'the_indexes_the_cascades_were_always_going_to_need',
    // Migration 57 made "delete this conversation" mean it, by putting ON DELETE CASCADE on the
    // memory rows a conversation produced. It did not bring the indexes those cascades are read
    // through, and a referential-integrity check with no index on the referencing column is a
    // sequential scan - one per deleted row.
    //
    // What that costs is not theoretical on a computer that has been lived in. Deleting a
    // conversation with four thousand events scans `tasks` four thousand times for the
    // branched_from_event_id check, once per event, and scans all of mem.item and mem.source once
    // each for theirs. The client's delete is optimistic with an Undo, so the row leaves the
    // sidebar instantly and the transaction goes on holding row locks on `tasks` behind it for as
    // long as it takes - which is the whole box unable to start a turn, with nothing on screen
    // saying why. `deleteWorkspaceCheckpoints` has the same shape against restored_checkpoint_id,
    // once per pruned checkpoint, on a retention sweep nobody is watching.
    //
    // Partial where the column is mostly null, which is all of them except workspace_id and
    // approvals.task_id: a promoted fact carries no task deliberately, most conversations are not
    // forks, and almost none were restored from a checkpoint. The predicate keeps the index the
    // size of the set that can actually be pointed at.
    //
    // Not CONCURRENTLY: every migration here runs inside the transaction migrateDatabase opens,
    // and CREATE INDEX CONCURRENTLY cannot. The lock is a SHARE on one table at a time, held for
    // as long as one owner's rows take to sort, against an installer that has already stopped the
    // services.
    //
    // The drop is the same argument backwards. workspace_checkpoints_task_idx leads on task_id and
    // orders by event_sequence; workspace_checkpoints_undo_idx (migration 53) leads on the same
    // column, orders by the same one, and breaks the tie with taken_seq. Every query the first can
    // answer the second answers too, so it was two index writes per checkpoint with one of them
    // reaching nothing.
    sql: `
      CREATE INDEX IF NOT EXISTS mem_item_task_idx
        ON mem.item (task_id) WHERE task_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS mem_source_task_cascade_idx
        ON mem.source (task_id) WHERE task_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_branched_from_idx
        ON tasks (branched_from_event_id) WHERE branched_from_event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_restored_checkpoint_idx
        ON tasks (restored_checkpoint_id) WHERE restored_checkpoint_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_workspace_idx ON tasks (workspace_id);
      CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals (task_id);

      DROP INDEX IF EXISTS workspace_checkpoints_task_idx;
    `
  },
  {
    version: 67,
    name: 'the_recall_statement_can_finally_reach_its_own_indexes',
    // Three of mem.item's partial indexes carried `status = 'active'` in their predicate, and not
    // one of them could ever be used by the statement they were built for.
    //
    // `MEMORY_RECALL_SQL` admits rows with a disjunction whose other two arms are bound parameters
    // the caller chooses - `q.want_superseded` and `q.scope` - and those arrive through a CTE, so
    // their values are not known when the plan is made. PostgreSQL therefore cannot prove
    // `status = 'active'` of any row the query might want, and pushes down the *relaxation* of the
    // disjunction instead. The plan says so in as many words, on a 50,000-row corpus:
    //
    //   ->  Seq Scan on item i_1  (rows=50000)
    //         Filter: ((status = 'active') OR (status = ANY ('{superseded,disputed}'))
    //                  OR (status = 'archived'))
    //
    // That is the *active-only* arm - the ordinary recall every task does, with no widening option
    // set. The audit recorded this as a cost the two model-facing switches impose (`includeSuperseded`,
    // `scope: 'archive'`); measured against the real statement rather than a hand-written one, the
    // switches are innocent and every recall was paying it. The lexical channel sequentially scanned
    // the whole memory table on every turn of every conversation.
    //
    // Measured, 50,000 items (40,000 active / 10,000 retired), two selective terms, pglite:
    //
    //   today                                  296.1 ms   lex_item: Seq Scan, 50,000 rows
    //   + a second partial index over the
    //     retired statuses                     295.1 ms   unchanged, and +2,160 kB on disk
    //   predicate dropped from the tsv index    80.0 ms   lex_item: Bitmap Heap Scan, 85 rows
    //   + subject and pin widened too           58.6 ms   struct: BitmapOr of all three
    //
    // The second partial index is the option this migration was written to consider and it is the
    // one the measurement rules out: it changes no plan and no timing, because its predicate is
    // exactly as unprovable as the one it was meant to complement. The disjunction has to become
    // provable, and the only way to do that without rewriting the statement into a UNION is to stop
    // asking the planner to prove anything about status.
    //
    // What it costs. At those 50,000 items the tsv index grows from 6,144 kB to 7,368 kB - the
    // retired fifth of the corpus, which is the whole of the price. mem_item_subject_idx goes
    // 672 -> 856 kB; mem_item_pin_idx does not move off 8 kB. The write path does not notice: 400
    // fresh rows into the populated table cost 4.6-5.2 ms each under every index shape, measured in
    // both orders, because an insert here is dominated by mem.index_row() building the tsvector and
    // the trigram array rather than by index maintenance.
    //
    // Nothing about which rows come back changes. An index predicate decides what is *in* an index,
    // never what a query returns; the status filter stays in the statement exactly as written, and
    // the retrieval eval scores identically on both sides of this migration.
    //
    // Not CONCURRENTLY, for migration 66's reason: these run inside migrateDatabase's transaction.
    // The DROP/CREATE pair leaves a window with no lexical index at all, which is the same window
    // the rest of the upgrade already occupies with the services stopped.
    sql: `
      DROP INDEX IF EXISTS mem.mem_item_tsv_gin;
      CREATE INDEX IF NOT EXISTS mem_item_tsv_gin ON mem.item USING gin (tsv)
        WITH (fastupdate = off);

      DROP INDEX IF EXISTS mem.mem_item_subject_idx;
      CREATE INDEX IF NOT EXISTS mem_item_subject_idx
        ON mem.item (workspace_id, subject_key, predicate, valid_from DESC)
        WHERE kind = 'fact';

      DROP INDEX IF EXISTS mem.mem_item_pin_idx;
      CREATE INDEX IF NOT EXISTS mem_item_pin_idx ON mem.item (workspace_id) WHERE pin;
    `
  },
  {
    version: 68,
    name: 'a_price_ceiling_to_store_and_three_reads_that_stop_scanning',
    // Two unrelated things that both belong to one upgrade, because both are columns and indexes
    // rather than rewrites and there is no reason to stop the box twice.
    //
    // ── The price ceiling ─────────────────────────────────────────────────────────────────────
    //
    // The three caps on this table are the running half of the brake: they stop a task that is
    // already spending. These two are the pre-flight half - they stop an over-priced route being
    // chosen in the first place, which is the only one of the two that works while the owner is
    // asleep. The whole apparatus for applying them has existed for two releases (`selectModel`,
    // `priceCeilingFields`, `CeilingOutcome`, `pricesAtPromptSize`) and `garden spend-ceiling set`
    // validates the number, refuses a bad one, and then exits 1 - because there has never been a
    // column to put it in. This is that column.
    //
    // DOUBLE PRECISION and `>= 0` rather than `> 0`, matching the two caps above rather than
    // `default_task_cap_usd` below them: null is "no ceiling" and zero is "only a route that
    // publishes no charge", and those are different states an owner can mean. No upper bound in the
    // SQL - the contract owns that, and a number here would be an eighth copied constant.
    //
    // ── Three statements that read the whole table to answer a bounded question ───────────────
    //
    // `tasks_unindexed_name_idx` is `listTasksMissingNameIndex`'s missing index. Its predicate is
    // the statement's WHERE clause, character for character, which is what lets the planner prove
    // the index covers it: the shape question is asked with an immutable operator against a
    // constant, so it can live in an index predicate the way `tasks_untitled_idx` (migration 33)
    // and `tasks_legacy_title_idx` do for their sibling backfills. Measured at 20,000
    // conversations: Seq Scan + top-N heapsort, 14.1 ms, on every API boot for the life of the box
    // - to discover there is nothing to do.
    //
    // The stamp is interpolated from `@garden/core` rather than written out, so it is the same
    // value the statement and every write use and cannot drift from them. A future stamp bump makes
    // this predicate stop matching, at which point the read falls back to the sequential scan it
    // does today and is correct but slow until a migration rebuilds the index - which is the right
    // failure direction, and `store.test.ts` holds the assertion that says so.
    //
    // `tasks_recent_terminal_idx` is the notifier's. `listPendingNotifications` runs every two
    // seconds per subscribed device and its `task_finished` arm enumerated every terminal
    // conversation the owner has ever had: measured, Seq Scan, "Rows Removed by Filter: 20000",
    // 23.5 ms, ~43,200 times a day, to deliver on average nothing. The horizon is already pushed
    // into the branch by the planner - it is visible in the plan - so what was missing was only
    // somewhere for it to land. `status` and `schedule_id` ride along as index columns so the
    // "is this a scheduled run" test is answered without a heap visit.
    //
    // `tasks_schedule_fold_idx` is the sidebar's. The fold that decides how many runs of each
    // schedule a page may show sequentially scanned every conversation on the box - 14,400 rows,
    // 9.1 ms of page one's 11.5 ms. The index carries the four columns the fold filters and groups
    // on and nothing else, so the aggregate is answered with Heap Fetches: 0.
    //
    // It carries no timestamp deliberately, and the reason is the whole of why it is cheap. With
    // `created_at` in it the index is 1,144 kB and the planner declines it - 957 against the
    // sequential scan's 1,011 was too close to be worth the risk it took. Without it there are only
    // as many distinct keys as the owner has schedules, so btree deduplication folds the whole thing
    // into 136 kB and the estimate drops to 437. Measured on 20,000 conversations of which 14,400
    // are runs of ten schedules: 10.06 ms sequential -> 6.45 ms index-only, at a twenty-eighth of
    // the size. `tasks_schedule_idx` (migration 62) already carries the timestamp for the LATERAL
    // that finds where each schedule's newest few runs stop, and still does.
    //
    // What is NOT here, and must not be added later without reading this: a `runs` counter on
    // `task_schedules`, which is what the refactor plan asked for. It cannot work. Migration 62
    // made `tasks.schedule_id` deliberately not a foreign key so that a run outlives the schedule
    // that minted it - turning a watcher off must not spill its past runs back into the sidebar as
    // separate lines. A counter on the schedule row counts nothing once that row is gone, so the
    // fold has to keep being derived from the conversations themselves. This index is what makes
    // deriving it cheap.
    sql: `
      ALTER TABLE spend_limits
        ADD COLUMN IF NOT EXISTS max_input_usd_per_million_tokens DOUBLE PRECISION
          CHECK (max_input_usd_per_million_tokens IS NULL
                 OR max_input_usd_per_million_tokens >= 0),
        ADD COLUMN IF NOT EXISTS max_output_usd_per_million_tokens DOUBLE PRECISION
          CHECK (max_output_usd_per_million_tokens IS NULL
                 OR max_output_usd_per_million_tokens >= 0);

      CREATE INDEX IF NOT EXISTS tasks_unindexed_name_idx
        ON tasks (created_at, id)
        WHERE name_tsv IS NULL OR NOT (name_tsv @@ '${CONVERSATION_NAME_INDEX_STAMP}'::tsquery);

      CREATE INDEX IF NOT EXISTS tasks_recent_terminal_idx
        ON tasks (user_id, (COALESCE(completed_at, updated_at)) DESC, status, schedule_id)
        WHERE status IN ('completed','failed','cancelled');

      CREATE INDEX IF NOT EXISTS tasks_schedule_fold_idx
        ON tasks (user_id, schedule_id, pinned, archived_at)
        WHERE schedule_id IS NOT NULL;
    `
  },
  {
    version: 69,
    name: 'drop_five_more_columns_no_code_writes',
    // The second sweep of the class migration 51 opened: columns that were declared, mapped onto a
    // record, served on a response, and never once written. Five of them, plus the unique index
    // that exists only to police one of them.
    //
    // ── workspace_previews.custom_domain, domain_status, domain_verification_hash ─────────────
    //
    // Custom domains for a published preview. Migration 25 added all three together with
    // `hosting_mode`, which migration 51 has already dropped for exactly this reason. No statement
    // in this repository has ever set any of them: `createWorkspacePreview` does not name them,
    // `publishWorkspacePreview` does not name them, and there is no route, no contract field and no
    // client control that could reach them. What existed was the read half - `mapWorkspacePreview`
    // lifted all three onto `WorkspacePreviewRecord`, so every preview response carried
    // `customDomain: null` and `domainStatus: null` as though they had been looked up.
    //
    // That is worse than a missing column rather than merely equal to one. A null that is served
    // reads as "no custom domain is configured"; a field that does not exist reads as "this build
    // does not do custom domains", which is the true statement. The verification hash is the one
    // that matters most: a field named `domain_verification_hash` sitting on the row is a claim
    // that this box can prove ownership of a domain, and it cannot.
    //
    // The index goes with them and is not merely tidy. `workspace_previews_custom_domain_idx` is
    // UNIQUE on `LOWER(custom_domain)` and would be the constraint enforcing "one preview per
    // domain" if the feature existed. It has never had a non-NULL row to compare, so it has never
    // been tested against the thing it guards, and leaving a untested uniqueness constraint behind
    // for whoever builds this later is how the second implementation inherits the first one's
    // assumptions without being told.
    //
    // ── mem.item.trigger_key ──────────────────────────────────────────────────────────────────
    //
    // Declared in the memory schema and carried through the insert as `input.triggerKey ?? null`,
    // with no caller anywhere supplying a `triggerKey`. It was the blind-index handle for
    // trigger-based procedure recall - "when you are about to do X, remember Y" - which the recall
    // planner does not implement: `planMemoryQuery` has no trigger channel, and every recall path
    // reaches procedures through the lexical, structural and fuzzy channels only.
    //
    // The insert parameter goes with the column in the same commit, because an input field that
    // silently writes nowhere is the half of this defect that survives a column drop.
    //
    // Nothing is rewritten here. Every statement below reshapes the table around rows that are
    // already correct, so this migration adds no entry to `REWRITING_MIGRATIONS` - and the test
    // that holds that table is what says so rather than this comment.
    sql: `
      DROP INDEX IF EXISTS workspace_previews_custom_domain_idx;
      ALTER TABLE workspace_previews DROP COLUMN IF EXISTS custom_domain;
      ALTER TABLE workspace_previews DROP COLUMN IF EXISTS domain_status;
      ALTER TABLE workspace_previews DROP COLUMN IF EXISTS domain_verification_hash;
      ALTER TABLE mem.item DROP COLUMN IF EXISTS trigger_key;
    `
  },
  {
    version: 70,
    name: 'owner_memory_leaves_the_workspace',
    // `workspace_memories.target` has had two values since migration 30. The UI calls one of them
    // "About you, everywhere" and the approval card says "loaded into every workspace on this
    // computer". Both were false: the only reader is `WHERE m.workspace_id=$2`, so an owner-tier
    // row was visible in exactly the workspace it was typed in, and - because `workspace_id` is
    // `NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE` - deleting that workspace destroyed
    // it. A fact about a person was being kept on the lifetime of a computer.
    //
    // Three columns' worth of change, and the ordering of them is the whole migration.
    //
    // `workspace_id` becomes nullable, because NULL is the only honest value for a row that
    // belongs to no workspace. A sentinel workspace would have been the shortcut and it fails on
    // the same cascade.
    //
    // `key_scope` records which key sealed the row, and it exists because ciphertext cannot be
    // re-sealed by a migration - this file has no master key and must never have one. Rows written
    // before today stay `'workspace'` and keep both their workspace id and their old AAD, so they
    // continue to open exactly as they did; the read path branches on this column rather than
    // guessing. An existing `target='user'` row is therefore not silently promoted into a scope it
    // was never encrypted for. Editing one re-seals it, which is where promotion actually happens
    // and where the owner is present to see it.
    //
    // The CHECK is what makes the pair inseparable afterwards. Without it `key_scope='user'` with
    // a `workspace_id` set is representable, and that row would be sealed under one key, reachable
    // through another, and deleted by a cascade it was supposed to have escaped.
    //
    // Nothing is rewritten. Every statement reshapes the table around rows that are already
    // correct under the new constraint, so this adds no entry to `REWRITING_MIGRATIONS`.
    sql: `
      ALTER TABLE workspace_memories ALTER COLUMN workspace_id DROP NOT NULL;

      ALTER TABLE workspace_memories ADD COLUMN IF NOT EXISTS key_scope TEXT
        NOT NULL DEFAULT 'workspace'
        CHECK (key_scope IN ('workspace','user'));

      ALTER TABLE workspace_memories DROP CONSTRAINT IF EXISTS workspace_memories_scope_ck;
      ALTER TABLE workspace_memories ADD CONSTRAINT workspace_memories_scope_ck CHECK (
        (key_scope = 'user' AND workspace_id IS NULL AND target = 'user')
        OR (key_scope = 'workspace' AND workspace_id IS NOT NULL)
      );

      CREATE INDEX IF NOT EXISTS workspace_memories_owner_idx
        ON workspace_memories(user_id, created_at)
        WHERE key_scope = 'user';
    `
  },
  {
    version: 71,
    name: 'a_proposal_is_not_a_promotion',
    // Three columns, and each of them exists because something that is a property of one turn has
    // to survive that turn and be read by a pass which runs a day later.
    //
    // `mem.item.tainted` is the one that matters. "A turn that read somebody else's words settles
    // nothing durable", enforced only in the worker at the moment the episode is written, records
    // nothing about WHY. The verbatim owner text of that turn still goes into `mem.source`, because
    // sources are written unconditionally - so any later reader of `mem.source` would walk straight
    // past a gate that had no representation in the database at all. A nightly pass that reads
    // yesterday's turns is exactly such a reader.
    //
    // Deliberately NULLABLE with no default, which is the whole design of the column. Rows written
    // before today have no answer to "did that turn read somebody else's words", and the only
    // honest value for a question nobody recorded is unknown. `NOT NULL DEFAULT FALSE` would have
    // written a confident FALSE onto every historical episode, which is precisely the claim that
    // cannot be made. Readers test `tainted = FALSE`, so NULL is refused - an unknown turn is
    // treated as tainted, and the whole backlog is off the table for good rather than for a day.
    //
    // `origin` records which side nominated a candidate: the shipped regexes over the owner's own
    // sentence, or a model. It is not cosmetic - it decides the trust a promotion is minted at
    // (`stated` for the owner's words, `derived` for a model's wording of them) and it is what the
    // owner's queue selects on. Sticky towards `proposed` at the upsert, so a sentence a model
    // touched can never launder itself back into `observed` by being seen once by a regex.
    //
    // `dismissed_at` is the owner's refusal, and it has to be a column rather than a deletion for
    // one reason: a deleted candidate is re-proposed the next night, forever. Keeping the row keeps
    // the three keys, which are keyed blind hashes and are the whole of what the store needs to
    // refuse the sentence again. The draft is dropped at the same moment - the owner has said they
    // do not want it, so the only thing worth keeping is the refusal.
    //
    // `workspaces.memory_proposed_at` is the fourth, and it is on a different table because it is a
    // different kind of fact: not a property of a candidate but the clock the paid call is claimed
    // against. Consolidation's own cadence is a `Map` in the worker process and that is right for
    // it - the pass is idempotent maintenance, and running it twice costs a few UPDATEs. A model
    // call is money, and an in-process clock means a worker that restarts every twenty minutes
    // makes the "nightly" call every twenty minutes. This column is what the run is claimed
    // against, atomically, so two workers racing and one worker restarting both settle to one call.
    //
    // No index is added on `mem.item` for the nightly read. `mem_item_kind_idx (workspace_id, kind,
    // observed_at DESC) WHERE status='active'` is already an exact prefix of that query, and the
    // taint test is a filter over one day of episodes; a second partial index would be paid for on
    // every episode insert - which is every finished turn - to save nothing.
    //
    // Nothing here rewrites a row: two constant defaults, a nullable column, a CHECK that every
    // existing row already satisfies, and one partial index. No entry in `REWRITING_MIGRATIONS`.
    sql: `
      ALTER TABLE mem.item ADD COLUMN IF NOT EXISTS tainted BOOLEAN;

      ALTER TABLE mem.fact_candidate ADD COLUMN IF NOT EXISTS origin TEXT
        NOT NULL DEFAULT 'observed';
      ALTER TABLE mem.fact_candidate DROP CONSTRAINT IF EXISTS mem_fact_candidate_origin_ck;
      ALTER TABLE mem.fact_candidate ADD CONSTRAINT mem_fact_candidate_origin_ck
        CHECK (origin IN ('observed','proposed'));

      ALTER TABLE mem.fact_candidate ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS mem_fact_candidate_open_idx
        ON mem.fact_candidate (workspace_id, origin, last_seen DESC)
        WHERE dismissed_at IS NULL;

      ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS memory_proposed_at TIMESTAMPTZ;
    `
  },
  {
    version: 72,
    name: 'a_rule_keeps_the_exception_it_was_stated_with',
    // Corroboration counts a whole sentence, so a rule and the same rule with the owner's carve-out
    // attached are two rows with two counters - and the bare one collects the sightings while the
    // qualified one is left a singleton. Measured on this machine's own 648 owner-typed turns, the
    // slogan clears two-sightings-a-day-apart in all four themes where a carve-out exists and the
    // carve-out clears it in none.
    //
    // The fix is an identity change, and it needs somewhere for the discarded half to live.
    // `mem.fact_candidate.object_key` becomes the key of the rule with its qualification stripped,
    // and the qualifications accumulate here, one row each, keyed by a blind hash of their own text
    // so the store can dedupe them without being able to read one.
    //
    // Deliberately NOT keyed on the candidate, and not deleted when the candidate is promoted. The
    // carve-outs belong to the RULE, not to the nomination that happened to carry them: a rule that
    // promoted in June and is given its exception in August must be able to pick it up, and it can
    // only do that if the August row can still see what June accumulated. Because rows are only
    // ever inserted here, the set a rule carries is monotone - a promotion can add a carve-out to a
    // rule and nothing on this path can remove one, which is the property that makes "never bare"
    // hold after the first promotion as well as at it.
    //
    // `mem.item.qualification_keys` is the same set as it stood when a row was minted, and it is
    // what lets the store answer "does the live row already say this?" without reading either. A
    // candidate whose accumulated keys are all present reattaches as before; one carrying a key the
    // row lacks mints the fuller row and supersedes the thinner one.
    //
    // Nothing here rewrites a row: one new table and one nullable column with no default. No entry
    // in `REWRITING_MIGRATIONS`. No index is added on the new table - its primary key is
    // `(workspace_id, subject_key, predicate, object_key, qualification_key)` and every read is a
    // prefix of that.
    sql: `
      CREATE TABLE IF NOT EXISTS mem.fact_qualification (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        subject_key TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object_key TEXT NOT NULL,
        qualification_key TEXT NOT NULL,
        ciphertext JSONB NOT NULL,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, subject_key, predicate, object_key, qualification_key)
      );

      ALTER TABLE mem.item ADD COLUMN IF NOT EXISTS qualification_keys TEXT[];
    `
  },
  {
    version: 73,
    name: 'the_owner_writes_one_block',
    // One text per person, written by the person, read into every request of every task.
    //
    // The tier beside it - `workspace_memories` with `key_scope='user'` - is rows, and rows have to
    // win a ranking to be read: measured against the production ranker, sixteen owner rows survive
    // fourteen matching workspace rows, lose two at eighteen and all sixteen at thirty-two, and
    // there is no row cap on the tier they compete with. A row that must out-score a search result
    // to be read is a search result. This table is the other thing, and its whole design is that
    // nothing ranks it: one row, addressed by the person, rendered whole or not at all.
    //
    // `user_id` is the PRIMARY KEY, which is the "one text" claim written where it cannot be
    // wished away. There is no `workspace_id` here at all - not nullable, absent - so nothing
    // cascades from deleting a computer and no statement can file a block against one.
    //
    // THE BOUND IS ON THE PLAINTEXT AND IT IS ENFORCED BY A DATABASE THAT CANNOT READ IT. AES-256-GCM
    // is a stream construction: the ciphertext is exactly as long as the plaintext, with the tag
    // carried separately in its own column of the envelope. So `octet_length(decode(...))` is the
    // byte length of the owner's own text, to the byte, and the CHECK is the real bound rather than
    // a number the writer also supplies and could get wrong. A counter column beside it would have
    // been a second way to say the same thing, and the two would eventually disagree.
    //
    // At the bound the write is REFUSED. Nothing is evicted and nothing is truncated: this is the
    // one surface whose content the owner typed about themselves, and a sentence that quietly
    // disappeared to make room is something they can never find out was dropped. The workspace tier
    // can afford eviction because its rows die with the computer; this cannot.
    //
    // The context CHECK is the second half of `ownerBlockAad`'s guarantee, moved into the schema.
    // The GCM tag proves the ciphertext and the AAD were made together; it does not prove the AAD
    // names THIS row's owner, so a block lifted from one account's row into another's decrypts
    // perfectly well for anyone holding the first key. Here the row cannot be filed at all unless
    // the sealed context names the user it is filed under.
    //
    // It is spelled with `IS NOT NULL` in front, and that clause is the whole constraint rather
    // than belt and braces. `encryptBytes` omits `aad` entirely when it is not given one, so
    // `ciphertext->>'aad'` is then SQL NULL, `NULL = 'owner-block:…'` is NULL, and a CHECK fails
    // only on FALSE - the row with no sealed context at all was the one row this constraint let
    // through, and `assertAad` returns early on an absent AAD by design, so nothing downstream
    // caught it either.
    //
    // And it names the SURFACE, not the person. `user-memory:` seals the owner's ranked memory
    // rows, which share this table's key and are also about this table's person, so under that
    // string an owner-tier row's envelope was a legal block and could be moved across with no key
    // at all - turning a row with a lapsed `validUntil` into an unranked, never-expiring resident
    // one, since this table has no temporal column to stop it.
    //
    // `version` is the owner's own concurrency, not the schema's: two settings tabs open on one
    // block must not silently overwrite each other, so a write states the version it read and the
    // statement refuses when that is stale.
    //
    // Nothing here rewrites a row - one new table with inline constraints, so a replay of the whole
    // list is a no-op on it. No entry in `REWRITING_MIGRATIONS`. No index: the primary key is the
    // only way this table is ever read.
    sql: `
      CREATE TABLE IF NOT EXISTS owner_blocks (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        ciphertext JSONB NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT owner_blocks_bound_ck
          CHECK (octet_length(decode(ciphertext->>'ciphertext','base64')) <= 2000),
        CONSTRAINT owner_blocks_context_ck
          CHECK (ciphertext->>'aad' IS NOT NULL
                 AND ciphertext->>'aad' = 'owner-block:' || user_id::text)
      );
    `
  },
  {
    version: 74,
    name: 'a_memory_can_reach_the_call_that_justified_it',
    // The one edge this store wrote nowhere: from a remembered turn to the tool call that proved it.
    //
    // `mem.evidence` already reaches the verbatim tier - the owner's request and the agent's
    // summary, chunked into `mem.source` - and that tier is under 1% of what a trajectory is made
    // of. The other 80% is tool results, and they are already retained untruncated in
    // `task_events`, written by `recordToolResult` with the raw object rather than the model's
    // bounded copy. Nothing could read them: no agent tool reaches `task_events` at all.
    //
    // The completion contract already produces the exact pointer that fixes this. A `finish`
    // cites the `toolCallId` of the call that justifies each claim; `memory-capture.ts` mapped that
    // evidence to `item.claim` and dropped the id one line before storage. This table keeps it.
    //
    // THE TRAP THIS DELIBERATELY REFUSES: not indexing the 80%. Nothing here is searchable and
    // nothing here holds a second copy of a result. `mem.lexeme_df` and `mem.corpus_stats` are
    // untouched, so the document-frequency statistics the verbatim tier's ranking rests on do not
    // move by one row. This is a pointer, and a pointer is the whole design: two ids and an edge.
    //
    // `event_id` rather than a scan. The alternative was to find the cited call by walking that
    // conversation's `tool_result` rows and decrypting each payload until one carried the id -
    // which is a read whose cost grows with the conversation and whose bound would have been a
    // number of rows to give up after. A foreign key is exact, is one index lookup, and cannot
    // dangle: the row goes when the event goes, and both go when the task goes. `tool_call_id` is
    // kept beside it because that is the id the model cited and the id a proof can compare against
    // the stored payload - the event id is where the harness put it, not what was cited.
    //
    // Both cascades are already the retention story this schema tells. `mem.item(id)` takes the
    // citation out with the memory; `task_events(id)` takes it out with the conversation, and
    // migration 57 made `mem.item.task_id` cascade from `tasks` so the memory goes at the same
    // moment. Deleting the conversation deletes the reach, which is what makes "reversible" true.
    //
    // The index on `event_id` is the FK's own: PostgreSQL indexes the referenced side and not the
    // referencing one, so without it every `task_events` delete - the delta prune runs on a
    // schedule - sequentially scans this table. It is not there for a read; every read is a prefix
    // of the primary key.
    //
    // `taint_origin` is the second half of `mem.item.tainted`, which says WHETHER the turn read
    // somebody else's words and could not say from where. The reach needs the where: material
    // pulled back out of a tainted turn is handed to the model fenced as untrusted and raises the
    // taint again, and the line the owner reads on their timeline names the source. Without this
    // the line could only say "somewhere", and a repeat origin across tasks - buying the ranking
    // for a query the owner will plausibly run - is the residual attack that record exists to make
    // visible. Nullable, because a turn that read nothing from outside has no origin to record and
    // because every row written before this migration has none; the readers treat an absent origin
    // on a row that is not known-untainted as untrusted, exactly as they treat `tainted IS NULL`.
    //
    // Nothing here rewrites a row: one new table with inline constraints, one index on it, and one
    // nullable column with no default. No entry in `REWRITING_MIGRATIONS`.
    sql: `
      CREATE TABLE IF NOT EXISTS mem.cited_call (
        item_id UUID NOT NULL REFERENCES mem.item(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL,
        event_id UUID NOT NULL REFERENCES task_events(id) ON DELETE CASCADE,
        PRIMARY KEY (item_id, tool_call_id)
      );
      CREATE INDEX IF NOT EXISTS mem_cited_call_event_idx ON mem.cited_call (event_id);

      ALTER TABLE mem.item ADD COLUMN IF NOT EXISTS taint_origin TEXT;
    `
  },
  {
    version: 75,
    name: 'a_use_gets_further_away_and_never_gone',
    /*
     * Two changes, and they are the same change: the usage half of the ranking stops having a
     * cliff, and the prior stops throwing away the half of salience that a failure produces.
     *
     * `mem.item_use_fold` — the tail of the use history, kept.
     *
     * `consolidateMemory` deletes `mem.item_use` rows past `useRetentionDays` (180). That bound is
     * real - the table takes one row per packed item per turn and is the only table here that
     * grows with usage rather than with content - but a sum over EVERY prior use cannot be taken
     * against a table that forgets. Without this, the cliff would only move to day 180.
     *
     * So the retention statement does not delete; it FOLDS. What leaves `mem.item_use` arrives
     * here as a count and a span, and the activation of the folded block is recovered from the
     * closed form of the same power law, which for `n` uses spread over `[a, b]` is
     *
     *     SUM_j (T - u_j)^-d  ~=  n / (b - a) * INTEGRAL_a^b (T - u)^-d du
     *                          =  n * [ (T-a)^(1-d) - (T-b)^(1-d) ] / ((1-d)(b-a))
     *
     * exact when the folded uses are uniform in their own span and correct in the limit at both
     * ends. That integral is evaluated in `consolidateMemory`, beside the live sum it is added to,
     * because `d` lives in `@garden/core` and must not be written down twice.
     *
     * Bounded by construction: one row per item, arriving only once an item has uses older than
     * the horizon, cascading with the item. `uses`/`cites`/`fails` mirror the three signals the
     * live half counts; `first_at`/`last_at` are the span, widened by LEAST/GREATEST as later
     * nights fold more in, so a second fold never double-counts and never narrows what it holds.
     *
     * `mem.prior` — the salience factor stops being one-sided.
     *
     * A one-sided factor, `1.0 + 0.15 * ln(1 + greatest(salience, 0))`, keeps negative
     * reinforcement from ever reaching the ranking: every negative salience maps to exactly the
     * factor of an unused row. `asinh` is the signed log - `ln(x + sqrt(x*x+1))`, odd, smooth,
     * exactly 0 at 0, logarithmic in both tails - and wrapping it in `exp` keeps the factor
     * strictly positive for every finite salience, which a bare `1 + c * asinh(s)` does not:
     * salience is a weighted sum of z-scores, a z-score in a workspace of `n` rows can reach
     * sqrt(n-1), and at large negative salience that shape would cross zero and invert the ranking
     * it multiplies.
     *
     * `exp(0.15 * asinh(s))` is `1 + 0.15*s + O(s^2)` at the origin, as is `1 + 0.15 * ln(1+s)`, so
     * nothing near zero moves. `0.15` is unchanged and deliberately so: the salience definition is
     * what this migration is changing, and moving the coefficient in the same pass would leave
     * neither measurable. It is a chosen number - across this owner's measured salience range it is
     * worth a factor of 0.94x to 1.25x, against 2.86x for the recency term beside it. What would
     * change it: a measurement of how far the usage tier SHOULD be able to move a rank, which
     * nothing in this repository has yet made.
     *
     * One new table, inline constraints, one CREATE OR REPLACE over a function body. Nothing
     * rewrites a row: no entry in `REWRITING_MIGRATIONS`. No index - every read of the new table
     * is by its primary key.
     */
    sql: `
      CREATE TABLE IF NOT EXISTS mem.item_use_fold (
        item_id UUID PRIMARY KEY REFERENCES mem.item(id) ON DELETE CASCADE,
        uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
        cites INTEGER NOT NULL DEFAULT 0 CHECK (cites >= 0),
        fails INTEGER NOT NULL DEFAULT 0 CHECK (fails >= 0),
        first_at TIMESTAMPTZ NOT NULL,
        last_at TIMESTAMPTZ NOT NULL,
        CHECK (last_at >= first_at),
        CHECK (cites <= uses AND fails <= uses)
      );

      CREATE OR REPLACE FUNCTION mem.prior(
        kind mem.kind, trust mem.trust, valid_to TIMESTAMPTZ, observed_at TIMESTAMPTZ,
        salience REAL, pin BOOLEAN, t_now TIMESTAMPTZ, temporal_intent BOOLEAN
      ) RETURNS FLOAT8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $ath$
        SELECT
            (CASE trust WHEN 'stated' THEN 1.00 WHEN 'derived' THEN 0.85 ELSE 0.60 END)
          * (CASE WHEN valid_to IS NULL OR valid_to > t_now THEN 1.00
                  WHEN temporal_intent THEN 0.60 ELSE 0.12 END)
          * (0.35 + 0.65 * exp(-0.6931471805599453
                * extract(epoch FROM t_now - observed_at) / 86400.0
                / CASE kind WHEN 'source'    THEN 21.0
                            WHEN 'episode'   THEN 45.0
                            WHEN 'procedure' THEN 240.0
                            ELSE 1200.0 END))
          * exp(0.15 * asinh(salience))
          * (CASE WHEN pin THEN 1.6 ELSE 1.0 END);
      $ath$;
    `
  },
  {
    version: 76,
    name: 'an_archived_turn_keeps_the_vector_it_is_found_by',
    /*
     * The far tier of the verbatim layer, made cheap enough to be a tier rather than a threat.
     *
     * `consolidateMemory` takes a turn out of the fast index past its archive horizon. The GIN
     * index is partial - `mem_source_tsv_gin ... WHERE indexed` - so flipping the flag is what
     * frees it, and that is the whole point of the horizon. What the flag ALSO did, through this
     * trigger, was null the row's `tsv`; paired with the pass's own `body_tokens=''` that left the
     * owner's words on disk with no representation anything could search, which is the one place
     * "no memory is ever totally gone, just further away" was still broken.
     *
     * The tokens are kept now, and a search of the far tier could rebuild the vector from them per
     * row at query time. Measured on the owner's real corpus - 1,006 turns, 2,394 rows - that is
     * 695 ms median against 50 ms for the indexed tier, and it grows linearly with the archive
     * forever. Reading the vector the row already had instead is 55 ms on the same rows with the
     * GIN index dropped: 5 ms of the 645 was the index, and all the rest was `to_tsvector` running
     * again on text that had already been tokenised once.
     *
     * So an archived row keeps its vector, and `indexed` goes back to meaning exactly one thing:
     * whether this row is in the GIN index. Out of the index, still in the heap, still matched by
     * `@@` on a scan. The vector costs no index bytes at all while `indexed` is false, because the
     * index that would hold it does not accept the row.
     *
     * The `item` branch is deliberately untouched. `rebuildMemoryCorpusStats` reads `mem.item`
     * with `tsv IS NOT NULL` and no `indexed` guard beside it, so a non-null vector on an
     * unindexed item would quietly enter the corpus statistics; the two `mem.source` arms of the
     * same statement do carry the guard. One table's behaviour changes and it is the one whose
     * readers were checked.
     *
     * The backfill is for rows an older build already archived. It sets the vector directly rather
     * than touching a trigger column, so it cannot be confused with a rewrite, and it skips rows
     * whose tokens the old pass erased - those cannot be rebuilt from anything the database holds,
     * because the lexemes are keyed in the worker. On a box where the citation exemption made the
     * pass unable to fire it moves nothing, which is the case this was written for.
     */
    sql: `
      CREATE OR REPLACE FUNCTION mem.index_row() RETURNS trigger LANGUAGE plpgsql AS $ath$
      BEGIN
        IF TG_TABLE_NAME = 'item' THEN
          IF NEW.indexed THEN
            NEW.tsv :=
                setweight(to_tsvector('simple', NEW.title_tokens), 'A')
             || setweight(to_tsvector('simple', NEW.tag_tokens), 'B')
             || setweight(to_tsvector('simple', NEW.alias_tokens), 'C')
             || setweight(to_tsvector('simple', NEW.body_tokens), 'D');
          ELSE
            NEW.tsv := NULL;
          END IF;
          NEW.pred_functional := NEW.predicate IS NOT NULL AND EXISTS (
            SELECT 1 FROM mem.predicate p
            WHERE p.name = NEW.predicate AND p.cardinality = 'one');
          NEW.trigram_len := COALESCE(cardinality(NEW.trigrams), 0);
        ELSE
          NEW.tsv := setweight(to_tsvector('simple', NEW.body_tokens), 'D');
        END IF;
        NEW.tsv_len := COALESCE(
          (SELECT SUM(COALESCE(array_length(positions, 1), 1)) FROM unnest(NEW.tsv)), 0)::int;
        RETURN NEW;
      END $ath$;

      UPDATE mem.source SET
        tsv = setweight(to_tsvector('simple', body_tokens), 'D'),
        tsv_len = COALESCE((SELECT SUM(COALESCE(array_length(u.positions, 1), 1))
                            FROM unnest(setweight(to_tsvector('simple', body_tokens), 'D')) u),
                           0)::int
      WHERE NOT indexed AND tsv IS NULL AND body_tokens <> '';
    `
  },
  {
    version: 77,
    name: 'a_resumed_schedule_gets_its_patience_back',
    /*
     * The streak that decides whether a schedule has stopped being worth retrying, kept on the
     * schedule instead of derived from the run ledger.
     *
     * Derivation was chosen first, on the argument that `task_schedule_runs` already records every
     * outcome and a column would be a second copy of a fact. It was measured wrong twice.
     *
     * (1) Resume had no effect on it. `setTaskScheduleEnabled` touches `enabled`, `next_run_at`,
     *     the lease and `last_error_code`, and nothing in `task_schedule_runs`, so the three
     *     failures that paused a schedule were still the three newest rows the moment the owner
     *     turned it back on. Measured through the real resume route: paused after three failures,
     *     resumed, then re-paused by ONE more. The threshold's own justification - "three is the
     *     smallest number that cannot be reached by a single bad moment" - was false in exactly the
     *     minutes after a resume, which is when the transients it names are most likely to still be
     *     going.
     * (2) The evidence expires before a slow schedule can accumulate it. `task_schedule_runs` is
     *     pruned at NOTIFICATION_LEDGER_INTERVAL - thirty days - by `cleanupExpired`, while a cron
     *     spec may be monthly. Three consecutive monthly failures span about sixty-two days, so the
     *     oldest row was deleted before the third arrived: the derived streak topped out at two and
     *     a monthly schedule failed forever, which is the behaviour the pause exists to end. A
     *     column is not pruned by anything.
     *
     * Not backfilled. A schedule that is mid-streak when this applies starts again at zero and gets
     * at most three more failed runs before it pauses, once. That is the direction that errs toward
     * a schedule staying on, and the alternative - a windowed read over the ledger at migration time
     * - would risk pausing a schedule on evidence nobody could see afterwards.
     *
     * DEFAULT 0 and NOT NULL, so every row already has the value the readers below expect and no
     * code has to decide what a null streak means. Postgres 11 and later add a defaulted column
     * without rewriting the table, so this takes no long lock on a box with many schedules.
     */
    sql: `
      ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS consecutive_failures
        INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    version: 78,
    name: 'the_folded_tail_remembers_which_uses_were_graded',
    /*
     * `mem.item_use_fold.oks` - the half of the folded block that a use actually earned.
     *
     * The live half of the usage score partitions `mem.item_use` on `outcome`, and without this the
     * fold holds two of the three counts it needs: `uses` (all of them), `cites` and `fails`.
     * Recovering the positive block as `uses - fails` counts every use the harness did not watch
     * fail - and `unknown` is not a use the harness watched at all. It is the row `recallMemory`
     * writes for something it merely returned and the row `recordMemoryPackOutcome` writes for a
     * packed entry the finished turn never touched.
     *
     * The live half of the score does not credit an ungraded use (see the salience recompute in
     * `packages/data/src/store/memory.ts`), so the fold has to be able to say the same thing about
     * the tail, or the discipline would expire at the retention horizon and 181-day-old
     * self-agreement would count as success while yesterday's does not. That is the same class of
     * cliff the fold exists to keep out of the count, arriving through the outcome instead.
     *
     * THE BACKFILL IS DELIBERATELY `uses - fails`, not the graded count. A folded block has already
     * thrown its per-use rows away, so which of its uses were graded is unrecoverable from anything
     * this database holds - any value here is a guess, and `uses - fails` is the guess that leaves
     * every already-folded block scoring exactly what it scored the day before this applied. The
     * alternative, zero, would silently delete the positive history of every row that had folded,
     * on no evidence, at the moment of an upgrade. Rows folded from here on are counted honestly by
     * the fold statement itself.
     *
     * The CHECK is `oks + fails <= uses` rather than `oks <= uses`, because `ok`, `fail` and
     * `unknown` partition the outcomes: the two graded counts cannot together exceed the total, and
     * the slack between them is exactly the ungraded tail. `cites` keeps its own separate bound
     * because a citation is a subset of the graded uses rather than a fourth class.
     *
     * One added column with a default, one backfill over it, one constraint. Postgres adds a
     * defaulted column without rewriting the table, and the fold holds one row per item that has
     * outlived the retention horizon, so this is short on any box. It rewrites rows, so it has an
     * entry in `REWRITING_MIGRATIONS` and an upgrade test in `store.test.ts`.
     */
    sql: `
      ALTER TABLE mem.item_use_fold ADD COLUMN IF NOT EXISTS oks
        INTEGER NOT NULL DEFAULT 0 CHECK (oks >= 0);

      UPDATE mem.item_use_fold SET oks = uses - fails WHERE oks = 0 AND uses > fails;

      ALTER TABLE mem.item_use_fold DROP CONSTRAINT IF EXISTS mem_item_use_fold_graded_check;
      ALTER TABLE mem.item_use_fold ADD CONSTRAINT mem_item_use_fold_graded_check
        CHECK (oks + fails <= uses);
    `
  },
  {
    version: 79,
    name: 'a_schedule_can_be_started_from_outside',
    /*
     * The inbound trigger: three nullable columns on `task_schedules` and one table of deliveries.
     *
     * Until this, the only things that could start a turn on this box were the owner and a clock -
     * verified by grep across the whole tree: no webhook route, no HMAC verification, no mail
     * arrival, no file watch. The substitute was a poller, which pays a full model turn on every
     * occurrence to find out that nothing happened.
     *
     * COLUMNS RATHER THAN A SIXTH `spec.kind`, for the reason `TaskScheduleTrigger` in
     * @garden/contracts states: three exhaustive narrowings elsewhere in the tree stop compiling on
     * a sixth member, and a webhook is orthogonal to a timing rather than a case of it. All three
     * are NULL on every row that exists, so nothing is backfilled and no reader has to decide what
     * an absent trigger means - `trigger_path IS NULL` is "no door", which is every schedule today.
     *
     * `trigger_path` is UNIQUE through a partial index rather than a column constraint, because a
     * plain UNIQUE would index every NULL row - and almost every row is NULL. The path is the
     * lookup key for an unauthenticated request, so it is the one index on this table that has to
     * be exact: two rows sharing a path would make which schedule fires a race.
     *
     * `trigger_secret_ciphertext` is sealed under the WORKSPACE key, like `prompt_ciphertext` beside
     * it, so the plaintext secret exists in this database at no point. Anyone who can read the
     * table but not unwrap the workspace key cannot forge a signature.
     *
     * DELIVERIES ARE ROWS AND NOT FILES because the request that carries one arrives at the API,
     * while the workspace it belongs to may be suspended: writing straight through would make an
     * inbound delivery fail whenever the computer was asleep, which is most of the time on a box
     * that is doing its job. The dispatcher writes them into the workspace when it wakes it.
     *
     * `UNIQUE(schedule_id, signature)` is the replay defence. A signature is an HMAC over the
     * timestamp and the exact body, so a replayed request inside the five-minute window is the same
     * signature and is refused by this index rather than by application logic that has to remember
     * to look. It doubles as idempotency for a sender that retries, which is what GitHub, Stripe
     * and every other webhook publisher does on a timeout.
     *
     * `delivered_at IS NULL` is the pending set, indexed partially for the same reason as the path:
     * the dispatcher asks that question on every poll of a trigger schedule and never asks about
     * the delivered ones. `body_ciphertext` is not indexed and never will be; it is a payload.
     *
     * `byte_size` has exactly one reader, and it is named here because a column nothing reads is a
     * column that quietly stops being true: `recordTriggerDelivery` sums it over the pending set and
     * the 429 that refuses a backed-up sender says how many bytes are waiting. The count on its own
     * does not answer that - sixteen unread deliveries is sixteen bytes or a megabyte about to be
     * written into the owner's workspace. It bounds nothing; `MAX_DELIVERY_BYTES` and the pending
     * cap are the bounds.
     *
     * `task_id` is the claim, and it is not the same fact as `delivered_at`. A run's prompt is
     * sealed naming these deliveries inside `materializeTaskSchedule`, and the files are written
     * afterwards, outside that transaction - so `task_id` says which run PROMISED a delivery and
     * `delivered_at` says which run got it. The stranded-run recovery reads the first to finish a
     * promise a prompt already made; every other reader asks only the second.
     *
     * Three added columns and one new table. Nothing is rewritten, so there is no entry in
     * `REWRITING_MIGRATIONS`.
     */
    sql: `
      ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS trigger JSONB;
      ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS trigger_path TEXT;
      ALTER TABLE task_schedules ADD COLUMN IF NOT EXISTS trigger_secret_ciphertext JSONB;
      CREATE UNIQUE INDEX IF NOT EXISTS task_schedules_trigger_path_idx
        ON task_schedules(trigger_path) WHERE trigger_path IS NOT NULL;

      CREATE TABLE IF NOT EXISTS task_schedule_deliveries (
        id UUID PRIMARY KEY,
        schedule_id UUID NOT NULL REFERENCES task_schedules(id) ON DELETE CASCADE,
        signature TEXT NOT NULL,
        body_ciphertext JSONB NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        delivered_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(schedule_id, signature)
      );
      CREATE INDEX IF NOT EXISTS task_schedule_deliveries_recent_idx
        ON task_schedule_deliveries(schedule_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS task_schedule_deliveries_pending_idx
        ON task_schedule_deliveries(schedule_id, created_at)
        WHERE delivered_at IS NULL;
    `
  },
  {
    version: 80,
    name: 'a_notification_can_reach_a_phone_with_no_subscription',
    /*
     * The second transport: one destination per owner per kind, and a ledger of its own.
     *
     * Every branch of the notification candidate set joined `push_subscriptions`, so an owner with
     * no registered device was offered nothing of any kind, for ever - docs/OPERATIONS.md carried
     * that as an open item. A destination is the owner-level target that query now selects on
     * beside a device: a paired chat on a messaging service, reached by its bot API.
     *
     * `config_ciphertext` is the bot token and the loopback API token, sealed by the API under the
     * master key with the row's own id in the context, so a row moved between accounts does not
     * open. `sender_id` is the numeric sender the owner's phone presented at pairing; every inbound
     * decision is checked against it and never against a chat id or a username, because a group's
     * chat id is not a person and a username is renameable. `pairing_hash` is the SHA-256 of a
     * one-time secret minted in Settings and never stored in the clear; `pairing_expires_at` bounds
     * it. `last_update_id` is the inbound poller's cursor. `redact` defaults to true because the
     * service in between is not end-to-end encrypted: the default sends a title and a link.
     *
     * A SECOND LEDGER RATHER THAN A WIDER `notification_deliveries`: that table's primary key carries
     * a foreign key to `push_subscriptions`, and the tests that hold the push ledger to its shape
     * assert on exactly that. `external_ref` is the message id the service answered with, which is
     * what a later edit that clears the buttons is addressed to; `nonce` is bound into the button
     * data so a callback from a stale or forged card is refused before any store call; `outcome_at`
     * is set once the far side's card shows the decision and needs nothing more.
     *
     * Two new tables and no rewrite, so there is no entry in `REWRITING_MIGRATIONS`.
     */
    sql: `
      CREATE TABLE IF NOT EXISTS notification_destinations (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('telegram')),
        config_ciphertext JSONB NOT NULL,
        sender_id TEXT,
        pairing_hash TEXT,
        pairing_expires_at TIMESTAMPTZ,
        last_update_id BIGINT,
        redact BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        verified_at TIMESTAMPTZ,
        disabled_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, kind)
      );

      CREATE TABLE IF NOT EXISTS notification_destination_deliveries (
        destination_id UUID NOT NULL REFERENCES notification_destinations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('approval_required','task_finished','spend_paused',
                                            'agent_message','takeover_needed')),
        resource_id UUID NOT NULL,
        external_ref TEXT,
        nonce TEXT,
        delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        outcome_at TIMESTAMPTZ,
        PRIMARY KEY(destination_id, kind, resource_id)
      );
      CREATE INDEX IF NOT EXISTS notification_destination_deliveries_time_idx
        ON notification_destination_deliveries(delivered_at);
      CREATE INDEX IF NOT EXISTS notification_destination_deliveries_open_idx
        ON notification_destination_deliveries(destination_id, resource_id)
        WHERE kind='approval_required' AND outcome_at IS NULL;
    `
  },
  {
    version: 81,
    name: 'a_share_is_ciphertext_nobody_on_this_box_can_open',
    /*
     * Share links: two tables, and the shape of both is the security argument.
     *
     * `task_shares` is one row per link the owner made. `lookup_hash` is the SHA-256 of the 22
     * character segment in the link's path, so the table can find a row for a request and a copy
     * of the table cannot produce a request. `envelope` is the snapshot - the owner's messages, the
     * assistant's replies, one line per tool step, the artifact names - sealed with AES-256-GCM
     * under a key that exists in exactly two places: the fragment of the link the owner was handed
     * once, and the memory of the browser reading it. Not in this row, not in any row, not in the
     * workspace key and not derivable from the master key. Every failure the public surface can
     * have - a log line, a backup on the wrong disk, an enumeration, a bug in the handler, a
     * link-preview bot - therefore yields bytes nobody can read. The AAD is `share:<lookup_hash>`,
     * so an envelope moved onto another share's row fails its tag.
     *
     * `manifest` names how many artifacts the link carries and how large each is, and nothing else.
     * Names and types live inside the encrypted snapshot; the public route addresses an artifact
     * by its index in this list, so no artifact id, storage key or workspace path is ever public.
     *
     * `task_share_artifacts` holds the bytes, copied out of the workspace at share time - the agent
     * can rewrite `.garden/artifacts/*` afterwards, and a link is a promise about what it showed
     * when it was made. BYTEA rather than a directory on disk, deliberately: the task cascade then
     * removes them for free, a backup carries them as the ciphertext they are, and the embedded
     * database the tests run on covers the same statement production runs. `envelope_meta` is the
     * public half of the envelope - version, IV, tag and AAD - kept apart from the ciphertext so
     * the blob route can list every artifact's envelope without reading a byte of any of them.
     *
     * `ON DELETE CASCADE` from `tasks`, `workspaces` and `users`, and `deleteTask` deletes the rows
     * explicitly as well: a share must not outlive the conversation it was cut from, and that
     * invariant should not rest on a constraint alone.
     *
     * `expires_at` NULL is the deliberate choice of never; `revoked_at` is immediate and final -
     * the artifact rows go with it, the share row stays so the owner's list can say what happened.
     * `view_count` and `last_viewed_at` are the whole of what is recorded about readers: no
     * address, no agent string, no identity.
     *
     * Two new tables and their indexes. Nothing is rewritten, so there is no entry in
     * `REWRITING_MIGRATIONS`.
     */
    sql: `
      CREATE TABLE IF NOT EXISTS task_shares (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        lookup_hash TEXT NOT NULL UNIQUE,
        envelope JSONB NOT NULL,
        manifest JSONB NOT NULL DEFAULT '[]'::jsonb,
        snapshot_bytes INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_bytes >= 0),
        version INTEGER NOT NULL DEFAULT 1,
        expires_at TIMESTAMPTZ,
        view_count INTEGER NOT NULL DEFAULT 0,
        last_viewed_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS task_shares_task_idx ON task_shares(task_id);
      CREATE INDEX IF NOT EXISTS task_shares_owner_idx ON task_shares(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS task_share_artifacts (
        share_id UUID NOT NULL REFERENCES task_shares(id) ON DELETE CASCADE,
        n INTEGER NOT NULL CHECK (n >= 0),
        envelope_meta JSONB NOT NULL,
        ciphertext BYTEA NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        PRIMARY KEY (share_id, n)
      );
    `
  },
  {
    version: 82,
    name: 'the_paired_sender_is_sealed_like_the_token_beside_it',
    /*
     * The sender the owner's phone presented at pairing is also the private chat every outbound
     * message is addressed to, and it was the one part of the destination row kept in the clear.
     * A copy of the table therefore tied the owner to an account on the messaging service and,
     * beside a recovered bot token, named the address to send to. `sender_ciphertext` is that id
     * sealed under the master key with the owner's and the row's ids in the context, exactly as
     * the token beside it is; the data layer opens it for the sender and the inbound poller and
     * for nothing else. The API serves `paired`, never the id, so no route changes shape.
     *
     * The plaintext column goes rather than being carried over: a migration holds no master key,
     * so it cannot seal what is there. A destination paired before this migration keeps its
     * verification and loses its sender, which the notifier reports once as unreadable and the
     * settings page shows as "no phone is paired to it" - one new pairing link puts it right. No
     * row is written, so there is no entry in `REWRITING_MIGRATIONS`.
     */
    sql: `
      ALTER TABLE notification_destinations ADD COLUMN IF NOT EXISTS sender_ciphertext JSONB;
      ALTER TABLE notification_destinations DROP COLUMN IF EXISTS sender_id;
    `
  },
  {
    version: 83,
    name: 'memory_source_sealed_provenance',
    // Source bodies and their evidence links must survive a provenance schema upgrade unchanged.
    // Empty metadata means no provenance was recorded; it never guesses a locator from content.
    sql: `
      ALTER TABLE mem.source ADD COLUMN IF NOT EXISTS origin_ciphertext JSONB NOT NULL
        DEFAULT '{}'::jsonb;
      ALTER TABLE mem.source ADD COLUMN IF NOT EXISTS origin_key TEXT;
      CREATE INDEX IF NOT EXISTS mem_source_origin_idx
        ON mem.source (workspace_id, origin_key, occurred_at DESC) WHERE origin_key IS NOT NULL;
    `
  },
  {
    version: 84,
    name: 'release_finished_message_reservations',
    // Promoted messages have finished with their terminal task. Queued work keeps its capacity,
    // and settled provider charges remain billing history rather than refundable reservations.
    sql: `
      UPDATE usage_entries u SET state='released'
      FROM task_message_queue q JOIN tasks t ON t.id=q.task_id AND t.user_id=q.user_id
      WHERE q.status='promoted' AND t.status IN ('completed','failed','cancelled')
        AND u.idempotency_key=q.reservation_key AND u.task_id=q.task_id AND u.user_id=q.user_id
        AND u.kind='task_compute' AND u.state='reserved';
    `
  },
  {
    version: 85,
    name: 'task_reasoning_preferences',
    sql: `
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reasoning_effort TEXT NOT NULL DEFAULT 'auto'
        CHECK (reasoning_effort IN ('auto','none','minimal','low','medium','high','xhigh','max'));
      ALTER TABLE task_message_queue ADD COLUMN IF NOT EXISTS reasoning_effort TEXT NOT NULL DEFAULT 'auto'
        CHECK (reasoning_effort IN ('auto','none','minimal','low','medium','high','xhigh','max'));
    `
  },
  {
    version: 86,
    name: 'durable_provider_media_submissions',
    sql: `
      CREATE TABLE IF NOT EXISTS provider_media_jobs (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        request_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        request_ciphertext JSONB NOT NULL,
        model_id TEXT NOT NULL,
        operation TEXT NOT NULL DEFAULT 'generate' CHECK (operation IN ('generate','edit','extend')),
        source_job_id UUID REFERENCES provider_media_jobs(id),
        duration_seconds INTEGER CHECK (duration_seconds BETWEEN 1 AND 120),
        extension_count INTEGER NOT NULL DEFAULT 0 CHECK (extension_count BETWEEN 0 AND 6),
        status TEXT NOT NULL CHECK (status IN ('queued','submitting','submission_uncertain','pending','in_progress','delivering','completed','failed','cancelled','expired','delivery_failed')),
        provider_job_id TEXT,
        progress DOUBLE PRECISION CHECK (progress >= 0 AND progress <= 100),
        reservation_usd DOUBLE PRECISION NOT NULL CHECK (reservation_usd >= 0 AND reservation_usd < 'Infinity'),
        cost_usd DOUBLE PRECISION CHECK (cost_usd >= 0 AND cost_usd < 'Infinity'),
        cost_source TEXT NOT NULL DEFAULT 'unresolved' CHECK (cost_source IN ('provider','quote','unresolved')),
        watching BOOLEAN NOT NULL DEFAULT TRUE,
        retention_approved_at TIMESTAMPTZ NOT NULL,
        output_path TEXT,
        artifact_id UUID,
        error_ciphertext JSONB,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS provider_media_jobs_poll_idx ON provider_media_jobs(next_poll_at)
        WHERE watching AND status IN ('queued','submitting','pending','in_progress','delivering');
      CREATE INDEX IF NOT EXISTS provider_media_jobs_task_idx ON provider_media_jobs(user_id,task_id,created_at DESC);
    `
  },
  {
    version: 87,
    name: 'task_presentation_read_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS task_events_evidence_cursor_idx ON task_events(task_id,sequence DESC)
        WHERE kind NOT IN ('assistant_delta','assistant_reasoning');
      CREATE INDEX IF NOT EXISTS task_events_delivery_receipt_idx ON task_events(task_id,kind,sequence DESC)
        WHERE kind IN ('preview','completed');
      CREATE INDEX IF NOT EXISTS artifacts_task_created_idx ON artifacts(task_id,created_at DESC);
    `
  },
  {
    version: 88,
    name: 'native_media_asset_intents',
    sql: `
      CREATE TABLE IF NOT EXISTS provider_media_assets (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        provider_hash TEXT NOT NULL,
        request_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        request_ciphertext JSONB NOT NULL,
        result_ciphertext JSONB,
        status TEXT NOT NULL DEFAULT 'submitting' CHECK (status IN ('submitting','completed','submission_uncertain','failed')),
        reservation_usd DOUBLE PRECISION NOT NULL CHECK (reservation_usd>0 AND reservation_usd<=10000),
        cost_usd DOUBLE PRECISION CHECK (cost_usd>=0 AND cost_usd<=10000),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS provider_media_assets_workspace_idx ON provider_media_assets(user_id,workspace_id,provider_hash,created_at DESC);
    `
  },
  {
    version: 89,
    name: 'native_coding_missions',
    sql: `
      ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS internal_parent_task_id UUID REFERENCES tasks(id) ON DELETE CASCADE;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES tasks(id) ON DELETE CASCADE;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_mission_id UUID;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS has_coding_family BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE INDEX IF NOT EXISTS tasks_parent_task_idx ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS coding_families (
        parent_task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        ceiling_credits DOUBLE PRECISION NOT NULL CHECK(ceiling_credits>0),
        initial_credits DOUBLE PRECISION NOT NULL CHECK(initial_credits>=0),
        wait_requested BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS coding_missions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        child_task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        child_workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
        request_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        manifest_ciphertext JSONB NOT NULL,
        phase TEXT NOT NULL DEFAULT 'preparing' CHECK(phase IN ('preparing','active','conflicted','integrating','integrated','cancelled','failed')),
        generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
        runner_generation INTEGER NOT NULL DEFAULT 0,
        runner_sealed BOOLEAN NOT NULL DEFAULT FALSE,
        allocated_credits DOUBLE PRECISION NOT NULL CHECK(allocated_credits>0),
        review_digest TEXT,
        changed_files INTEGER CHECK(changed_files>=0),
        conflicts INTEGER CHECK(conflicts>=0),
        detail_ciphertext JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS coding_missions_parent_idx ON coding_missions(user_id,parent_task_id,created_at);
      CREATE TABLE IF NOT EXISTS coding_family_calls (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        original_task_id UUID NOT NULL,
        parent_task_id UUID REFERENCES coding_families(parent_task_id) ON DELETE SET NULL,
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        reserved_credits DOUBLE PRECISION NOT NULL CHECK(reserved_credits>=0),
        actual_credits DOUBLE PRECISION CHECK(actual_credits>=0),
        reserved_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(reserved_usd>=0),
        actual_usd DOUBLE PRECISION CHECK(actual_usd>=0),
        usage_id UUID REFERENCES usage_entries(id),
        state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','uncertain')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS coding_family_calls_owner_idx ON coding_family_calls(user_id,created_at);
      CREATE INDEX IF NOT EXISTS coding_family_calls_parent_idx ON coding_family_calls(parent_task_id,task_id,state);
    `
  },
  {
    version: 90,
    name: 'durable_native_video_batches',
    sql: `
      CREATE TABLE IF NOT EXISTS provider_media_batches (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        request_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        request_ciphertext JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','uploading','file_uploaded','submitting','submission_uncertain','pending','delivering','completed','failed','cancelled')),
        input_file_id TEXT,provider_batch_id TEXT,error_ciphertext JSONB,
        provider_status TEXT,cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,cancel_sent BOOLEAN NOT NULL DEFAULT FALSE,
        total INTEGER NOT NULL CHECK (total>=1 AND total<=100),
        completed INTEGER NOT NULL DEFAULT 0 CHECK (completed>=0 AND completed<=100),
        failed INTEGER NOT NULL DEFAULT 0 CHECK (failed>=0 AND failed<=100),
        reservation_usd DOUBLE PRECISION NOT NULL CHECK (reservation_usd>0 AND reservation_usd<=1000000),
        watching BOOLEAN NOT NULL DEFAULT TRUE,
        lease_owner TEXT,lease_expires_at TIMESTAMPTZ,next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE provider_media_jobs ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES provider_media_batches(id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS provider_media_batches_pending_idx ON provider_media_batches(next_poll_at,id) WHERE watching;
      CREATE INDEX IF NOT EXISTS provider_media_batches_task_idx ON provider_media_batches(user_id,task_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS provider_media_jobs_batch_idx ON provider_media_jobs(batch_id) WHERE batch_id IS NOT NULL;
    `
  },
  {
    version: 91,
    name: 'device_bound_browser_authorization',
    sql: `
      CREATE TABLE IF NOT EXISTS native_authorizations (
        id UUID PRIMARY KEY,
        purpose TEXT NOT NULL CHECK (purpose IN ('sign_in','step_up')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','consumed')),
        server_origin TEXT NOT NULL,
        native_origin TEXT NOT NULL,
        challenge TEXT NOT NULL,
        device_public_key TEXT NOT NULL,
        device_label TEXT NOT NULL,
        user_code TEXT NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        target_session_hash TEXT,
        approving_session_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        CHECK ((purpose='sign_in' AND target_session_hash IS NULL) OR
               (purpose='step_up' AND target_session_hash IS NOT NULL AND user_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS native_authorizations_expiry_idx ON native_authorizations(expires_at);
    `
  },
  {
    version: 92,
    name: 'durable_media_delivery_outbox',
    sql: `
      CREATE TABLE IF NOT EXISTS provider_media_delivery_outbox (
        job_id UUID PRIMARY KEY REFERENCES provider_media_jobs(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_owner TEXT, lease_expires_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0,
        delivered_at TIMESTAMPTZ,
        notification_state TEXT NOT NULL DEFAULT 'pending' CHECK(notification_state IN ('pending','sent','suppressed_limit'))
      );
      CREATE INDEX IF NOT EXISTS provider_media_delivery_pending_idx ON provider_media_delivery_outbox(next_attempt_at,job_id) WHERE delivered_at IS NULL;
    `
  },
  {
    version: 93,
    name: 'bounded_owner_live_voice',
    sql: `
ALTER TABLE task_message_queue DROP CONSTRAINT IF EXISTS task_message_queue_max_compute_credits_check;
ALTER TABLE task_message_queue ADD CONSTRAINT task_message_queue_max_compute_credits_check CHECK(max_compute_credits>=0);
CREATE TABLE IF NOT EXISTS voice_sessions (
 id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,original_task_id UUID NOT NULL,workspace_id UUID NOT NULL,
 request_key TEXT NOT NULL,request_hash TEXT NOT NULL,auth_hash TEXT NOT NULL,
 ticket_hash TEXT,ticket_expires_at TIMESTAMPTZ NOT NULL,deadline_at TIMESTAMPTZ NOT NULL,
 details JSONB NOT NULL,configuration JSONB NOT NULL,connection JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'preparing' CHECK(status IN ('preparing','connecting','listening','responding','stopping','ended','expired','lost','usage_uncertain')),
 controller_id TEXT,lease_expires_at TIMESTAMPTZ,connected_at TIMESTAMPTZ,ended_at TIMESTAMPTZ,
 settled_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(settled_usd>=0),pending_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(pending_usd>=0),
 input_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,output_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
 current_response_id UUID,cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE,error_code TEXT,note TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_owner_active_idx ON voice_sessions(user_id) WHERE status IN ('preparing','connecting','listening','responding','stopping');
CREATE INDEX IF NOT EXISTS voice_task_idx ON voice_sessions(user_id,original_task_id,created_at DESC);
CREATE TABLE IF NOT EXISTS voice_responses (
 id UUID PRIMARY KEY,session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 reservation_key TEXT NOT NULL UNIQUE,provider_response_id TEXT,reserved_usd DOUBLE PRECISION NOT NULL CHECK(reserved_usd>0),
 state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','released')),cost_usd DOUBLE PRECISION,receipt JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(session_id,provider_response_id)
);
CREATE INDEX IF NOT EXISTS voice_response_session_idx ON voice_responses(session_id,state);
CREATE TABLE IF NOT EXISTS voice_proposals (
 id UUID PRIMARY KEY,session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider_call_id TEXT NOT NULL,digest TEXT NOT NULL,ciphertext JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected','expired')),
 message_id UUID,expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(session_id,provider_call_id)
);
`
  },
  {
    version: 94,
    name: 'approval_denial_corrections',
    sql: `
ALTER TABLE task_message_queue ADD COLUMN IF NOT EXISTS approval_id UUID UNIQUE REFERENCES approvals(id) ON DELETE CASCADE;
ALTER TABLE task_message_queue DROP CONSTRAINT IF EXISTS approval_correction_retains_allocation;
ALTER TABLE task_message_queue ADD CONSTRAINT approval_correction_retains_allocation
 CHECK(approval_id IS NULL OR (interrupt=TRUE AND max_compute_credits=0 AND max_spend_usd IS NULL));
CREATE INDEX IF NOT EXISTS approval_correction_pending_idx ON task_message_queue(task_id,created_at,id)
 WHERE approval_id IS NOT NULL AND status='queued';
`
  },
  {
    version: 95,
    name: 'isolated_project_execution',
    sql: `
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS parent_workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS project_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS workspace_project_parent_idx ON workspaces(parent_workspace_id) WHERE parent_workspace_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS project_executions (
 task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 parent_workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 source_workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'preparing' CHECK(status IN ('preparing','ready','shared','failed')),
 seed_kind TEXT NOT NULL CHECK(seed_kind IN ('new','legacy')),
 source_task_status TEXT NOT NULL,
 source_manifest_ciphertext JSONB NOT NULL,receipt_ciphertext JSONB,
 lease_owner TEXT,lease_expires_at TIMESTAMPTZ,last_error_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS project_execution_preparing_idx ON project_executions(updated_at,task_id) WHERE status='preparing';
ALTER TABLE coding_missions ADD COLUMN IF NOT EXISTS parent_workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
UPDATE coding_missions m SET parent_workspace_id=t.workspace_id FROM tasks t WHERE m.parent_task_id=t.id AND m.parent_workspace_id IS NULL;
`
  },
  {
    version: 96,
    name: 'sealed_project_model_preferences',
    sql: `
CREATE TABLE IF NOT EXISTS project_model_preferences (
 project_task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL CHECK(revision>0),choices_ciphertext JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`
  },
  {
    version: 97,
    name: 'prompt_approval_mode',
    sql: `
ALTER TABLE task_message_queue ADD COLUMN IF NOT EXISTS security_mode TEXT CHECK(security_mode IN ('review','balanced','autonomous'));
`
  },
  {
    version: 98,
    name: 'model_connections',
    /*
     * Which connection serves a model, so an account can hold more than one at a time.
     *
     * `provider` was doing two jobs: naming the id namespace a model lives in - every id is
     * `<provider>/<model>` - and naming the credential that reaches it. That collapsed every
     * non-OpenRouter endpoint into one bucket called `custom`, so connecting Ollama Cloud replaced
     * a configured endpoint rather than joining it, and the picker could only ever show one
     * provider's rows.
     *
     * Splitting the second job onto its own column is what makes several connections possible
     * without touching a single existing id. `custom/glm-5.3-flash` stays exactly that string -
     * finished tasks name their model by id and history has to keep reading - while the row now
     * also says which connection can actually call it.
     *
     * The backfill is deliberately blunt because it can afford to be: at the moment this runs an
     * account has at most one non-OpenRouter connection, so every `custom` row belongs to it, and
     * the API resolves the exact vendor from the credential it already holds. Rows written after
     * this carry their connection from the start.
     */
    sql: `
ALTER TABLE model_releases ADD COLUMN IF NOT EXISTS connection_id TEXT;
UPDATE model_releases SET connection_id=provider WHERE connection_id IS NULL;
CREATE INDEX IF NOT EXISTS model_releases_connection_idx ON model_releases(connection_id);
`
  },
  {
    version: 99,
    name: 'task_lifetime',
    /*
     * How long a conversation is meant to live, declared rather than assumed.
     *
     * Every task was bounded as the middle case: one renewable step budget, and anything it
     * published left serving until somebody removed it. A ten-minute mock-up therefore left a
     * website hosted indefinitely, and a three-day analysis stopped at a ceiling designed for a
     * conversation somebody was watching.
     *
     * No backfill statement, and that is the point: the column defaults to the behaviour every
     * existing row already has, so nothing that is running changes under a deploy. A run only moves
     * off `standard` because somebody said so.
     */
    sql: `
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lifetime TEXT NOT NULL DEFAULT 'standard'
  CHECK(lifetime IN ('brief','standard','sustained'));
`
  },
  {
    version: 100,
    name: 'preview_idle_window',
    /*
     * The idle window a preview renews by, kept on the preview instead of read from one constant.
     *
     * A `brief` conversation's page was created with a twenty-four hour deadline and every visit
     * renewed it to the global thirty days, because the renewal read the constant rather than the
     * row - so the first person to open a short-lived page turned it into a long-lived one, and
     * the lifetime flag stopped meaning anything the moment anybody looked at it.
     *
     * Nullable with no backfill: NULL means the ordinary window, which is what every existing row
     * already renews by, so nothing serving today changes when this lands.
     */
    sql: `
ALTER TABLE workspace_previews ADD COLUMN IF NOT EXISTS idle_interval INTERVAL;
`
  },
  {
    version: 101,
    name: 'model_throughput_ceiling',
    /*
     * How fast the quickest company serving a model runs, in the aggregator's own numbers.
     *
     * A speed floor has to be relative - some models cannot reach sixty tokens a second on any
     * company, and a fixed bar there would deprioritise every endpoint they have - and relative
     * needs a ceiling to be a share of. The aggregator will compare each company against a
     * threshold but publishes no per-endpoint figures to compute one from: `throughput_last_30m` is
     * declared on its endpoints route and returned null everywhere, for an API key as much as for
     * nobody.
     *
     * What it does answer is its own generation-stats route, for a request it has already served:
     * generation time, completion tokens, and the company that served it. Asked of a request the
     * aggregator itself routed by throughput, that measures the fastest company serving the model.
     * One row per model, and every number in it theirs.
     *
     * Not keyed by user. Which company is quickest at a model is a fact about the model and the
     * aggregator's fleet, not about whoever is paying.
     */
    sql: `
CREATE TABLE IF NOT EXISTS model_throughput_ceiling (
  model_id TEXT PRIMARY KEY,
  tokens_per_second DOUBLE PRECISION NOT NULL,
  provider_name TEXT NOT NULL,
  sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`
  },
  {
    version: 102,
    name: 'sealed_operation_receipts',
    sql: `ALTER TABLE api_operations ADD COLUMN IF NOT EXISTS response_ciphertext JSONB;`
  },
  {
    version: 103,
    name: 'draft_revision_tombstones',
    sql: `
      ALTER TABLE message_drafts ALTER COLUMN body_ciphertext DROP NOT NULL;
      ALTER TABLE message_drafts ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
    `
  },
  {
    version: 104,
    name: 'task_approval_grants',
    sql: `
      ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decision_scope TEXT NOT NULL DEFAULT 'once'
        CHECK(decision_scope IN ('once','run'));
      CREATE TABLE IF NOT EXISTS task_approval_grants (
        id UUID PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn INTEGER NOT NULL CHECK(turn >= 0),
        security_mode TEXT NOT NULL CHECK(security_mode IN ('review','balanced','autonomous')),
        scope_hash TEXT NOT NULL,
        scope_ciphertext JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS task_approval_grant_match_idx
        ON task_approval_grants(task_id,turn,security_mode,scope_hash) WHERE revoked_at IS NULL;
      CREATE OR REPLACE FUNCTION revoke_ended_task_approvals() RETURNS trigger LANGUAGE plpgsql AS $grant$
      BEGIN
        IF NEW.security_mode IS DISTINCT FROM OLD.security_mode OR
          (NEW.status IN ('completed','failed','cancelled') AND NEW.status IS DISTINCT FROM OLD.status) THEN
          UPDATE task_approval_grants SET revoked_at=NOW() WHERE task_id=NEW.id AND revoked_at IS NULL;
        END IF;
        RETURN NEW;
      END;
      $grant$;
      DROP TRIGGER IF EXISTS task_approval_grants_expire ON tasks;
      CREATE TRIGGER task_approval_grants_expire AFTER UPDATE OF status,security_mode ON tasks
        FOR EACH ROW EXECUTE FUNCTION revoke_ended_task_approvals();
    `
  },
  {
    version: 105,
    name: 'projects_and_conversations',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        security_mode TEXT NOT NULL DEFAULT 'balanced' CHECK(security_mode IN ('review','balanced','autonomous')),
        brief_ciphertext JSONB NOT NULL,
        title_source TEXT NOT NULL DEFAULT 'prompt',
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(id,user_id)
      );
      CREATE TABLE IF NOT EXISTS project_workspaces (
        project_id UUID NOT NULL,workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,origin_task_id UUID NOT NULL,
        PRIMARY KEY(project_id,workspace_id,origin_task_id),
        FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS project_notes (
        id UUID PRIMARY KEY,project_id UUID NOT NULL,user_id UUID NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('finding','decision','question')),
        body_ciphertext JSONB NOT NULL,source_ciphertext JSONB,
        replaces_id UUID REFERENCES project_notes(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),removed_at TIMESTAMPTZ,
        FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS project_note_correction_idx ON project_notes(replaces_id) WHERE replaces_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS project_notes_order_idx ON project_notes(project_id,created_at DESC,id DESC);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id UUID;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS model_override BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS model_choices_ciphertext JSONB;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS model_preferences_revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE task_message_queue ADD COLUMN IF NOT EXISTS model_override BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS conversation_source_ciphertext JSONB;
      WITH RECURSIVE membership AS (
        SELECT id,user_id,id AS project_id FROM tasks WHERE parent_task_id IS NULL
        UNION ALL
        SELECT t.id,t.user_id,m.project_id FROM tasks t JOIN membership m
          ON t.parent_task_id=m.id AND t.user_id=m.user_id
      ) UPDATE tasks t SET project_id=m.project_id FROM membership m WHERE t.id=m.id AND t.project_id IS NULL;
      DO $projects$
      BEGIN
        IF EXISTS(SELECT 1 FROM tasks WHERE project_id IS NULL) THEN
          RAISE EXCEPTION 'Project migration found cyclic or cross-owner conversation ancestry';
        END IF;
      END;
      $projects$;
      INSERT INTO projects(id,user_id,workspace_id,title,brief_ciphertext,security_mode,title_source,pinned,archived_at,created_at,updated_at)
        SELECT id,user_id,workspace_id,title,prompt_ciphertext,security_mode,title_source,pinned,archived_at,created_at,updated_at
        FROM tasks WHERE id=project_id ON CONFLICT(id) DO NOTHING;
      INSERT INTO project_workspaces(project_id,workspace_id,user_id,origin_task_id)
        SELECT t.project_id,t.workspace_id,t.user_id,t.id
        FROM tasks t JOIN workspaces w ON w.id=t.workspace_id AND w.user_id=t.user_id
        WHERE w.parent_workspace_id IS NOT NULL ORDER BY t.project_id,t.workspace_id,t.created_at,t.id
        ON CONFLICT DO NOTHING;
      ALTER TABLE usage_entries ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
      ALTER TABLE coding_family_calls ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
      UPDATE usage_entries u SET project_id=t.project_id FROM tasks t WHERE u.task_id=t.id AND u.user_id=t.user_id AND u.project_id IS NULL;
      UPDATE coding_family_calls c SET project_id=t.project_id FROM tasks t WHERE c.original_task_id=t.id AND c.user_id=t.user_id AND c.project_id IS NULL;
      CREATE INDEX IF NOT EXISTS usage_project_idx ON usage_entries(project_id) WHERE project_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS coding_call_project_idx ON coding_family_calls(project_id) WHERE project_id IS NOT NULL;
      CREATE OR REPLACE FUNCTION retain_usage_project() RETURNS trigger LANGUAGE plpgsql AS $projects$
      BEGIN
        SELECT project_id INTO NEW.project_id FROM tasks WHERE id=NEW.task_id AND user_id=NEW.user_id;
        RETURN NEW;
      END;
      $projects$;
      DROP TRIGGER IF EXISTS usage_assign_project ON usage_entries;
      CREATE TRIGGER usage_assign_project BEFORE INSERT ON usage_entries FOR EACH ROW EXECUTE FUNCTION retain_usage_project();
      CREATE OR REPLACE FUNCTION retain_coding_project() RETURNS trigger LANGUAGE plpgsql AS $projects$
      BEGIN
        SELECT project_id INTO NEW.project_id FROM tasks WHERE id=NEW.original_task_id AND user_id=NEW.user_id;
        RETURN NEW;
      END;
      $projects$;
      DROP TRIGGER IF EXISTS coding_assign_project ON coding_family_calls;
      CREATE TRIGGER coding_assign_project BEFORE INSERT ON coding_family_calls FOR EACH ROW EXECUTE FUNCTION retain_coding_project();
      ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_project_owner_fk;
      ALTER TABLE tasks ADD CONSTRAINT tasks_project_owner_fk FOREIGN KEY(project_id,user_id)
        REFERENCES projects(id,user_id) ON DELETE CASCADE;
      ALTER TABLE tasks ALTER COLUMN project_id SET NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_project_activity_idx ON tasks(project_id,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS projects_owner_activity_idx ON projects(user_id,updated_at DESC,id DESC);
      ALTER TABLE project_model_preferences DROP CONSTRAINT IF EXISTS project_model_preferences_project_task_id_fkey;
      ALTER TABLE project_model_preferences DROP CONSTRAINT IF EXISTS project_model_preferences_project_fk;
      ALTER TABLE project_model_preferences ADD CONSTRAINT project_model_preferences_project_fk
        FOREIGN KEY(project_task_id) REFERENCES projects(id) ON DELETE CASCADE;
      CREATE OR REPLACE FUNCTION assign_conversation_project() RETURNS trigger LANGUAGE plpgsql AS $projects$
      BEGIN
        IF NEW.project_id IS NULL AND NEW.parent_task_id IS NOT NULL THEN
          SELECT project_id INTO NEW.project_id FROM tasks WHERE id=NEW.parent_task_id AND user_id=NEW.user_id;
          IF NEW.project_id IS NULL THEN RAISE EXCEPTION 'Conversation parent is unavailable'; END IF;
        END IF;
        IF NEW.project_id IS NULL THEN
          NEW.project_id:=NEW.id;
          INSERT INTO projects(id,user_id,workspace_id,title,brief_ciphertext,security_mode,title_source,created_at,updated_at)
            VALUES(NEW.id,NEW.user_id,NEW.workspace_id,NEW.title,NEW.prompt_ciphertext,NEW.security_mode,NEW.title_source,NEW.created_at,NEW.updated_at);
        END IF;
        RETURN NEW;
      END;
      $projects$;
      DROP TRIGGER IF EXISTS tasks_assign_project ON tasks;
      CREATE TRIGGER tasks_assign_project BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION assign_conversation_project();
      CREATE OR REPLACE FUNCTION update_conversation_project() RETURNS trigger LANGUAGE plpgsql AS $projects$
      BEGIN
        INSERT INTO project_workspaces(project_id,workspace_id,user_id,origin_task_id)
          SELECT NEW.project_id,NEW.workspace_id,NEW.user_id,NEW.id FROM workspaces w
          WHERE w.id=NEW.workspace_id AND w.user_id=NEW.user_id AND w.parent_workspace_id IS NOT NULL
          ON CONFLICT DO NOTHING;
        IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
          UPDATE projects SET updated_at=GREATEST(updated_at,NEW.updated_at) WHERE id=NEW.project_id;
        END IF;
        IF TG_OP='UPDATE' AND NEW.id=NEW.project_id AND NEW.title_source='generated' AND OLD.title_source='prompt' THEN
          UPDATE projects SET title=NEW.title,title_source='generated',revision=revision+1
            WHERE id=NEW.project_id AND title_source='prompt';
        END IF;
        IF TG_OP='UPDATE' AND NEW.id=NEW.project_id AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
          UPDATE projects SET workspace_id=NEW.workspace_id WHERE id=NEW.project_id AND workspace_id=OLD.workspace_id;
        END IF;
        RETURN NEW;
      END;
      $projects$;
      DROP TRIGGER IF EXISTS tasks_update_project ON tasks;
      CREATE TRIGGER tasks_update_project AFTER INSERT OR UPDATE OF status,title,workspace_id ON tasks
        FOR EACH ROW EXECUTE FUNCTION update_conversation_project();
    `
  },
  {
    version: 106,
    name: 'durable_job_dependencies',
    sql: `
      CREATE TABLE IF NOT EXISTS task_job_waits (
        task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        id UUID NOT NULL,
        dependencies_ciphertext JSONB NOT NULL,
        outcome_ciphertext JSONB,
        state TEXT NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','delivered')),
        checked_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS task_job_waits_pending ON task_job_waits(checked_at) WHERE state='waiting';
    `
  },
  {
    version: 107,
    name: 'question_attention_identity',
    sql: `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pending_question_id UUID;`
  },
  {
    version: 108,
    name: 'native_account_oauth',
    sql: `ALTER TABLE connectors DROP CONSTRAINT IF EXISTS connectors_kind_check;
      ALTER TABLE connectors ADD CONSTRAINT connectors_kind_check
      CHECK (kind IN ('github','webdav','mcp_http','imap','caldav','google','microsoft'));`
  },
  {
    version: 109,
    name: 'durable_connector_operations',
    sql: `CREATE TABLE IF NOT EXISTS connector_operations (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      operation_key TEXT NOT NULL CHECK(operation_key ~ '^[a-f0-9]{64}$'),
      intent_key TEXT NOT NULL CHECK(intent_key ~ '^[a-f0-9]{64}$'),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed')),
      recovery_ciphertext JSONB,
      result_ciphertext JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id,connector_id,operation_key),
      CHECK(state <> 'completed' OR result_ciphertext IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS connector_operations_task ON connector_operations(task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS connector_operations_pending_intent ON connector_operations(user_id,connector_id,task_id,action,intent_key) WHERE state='pending';
    CREATE TABLE IF NOT EXISTS connector_operation_requests (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      operation_key TEXT NOT NULL CHECK(operation_key ~ '^[a-f0-9]{64}$'),
      operation_id UUID NOT NULL REFERENCES connector_operations(id) ON DELETE CASCADE,
      PRIMARY KEY(user_id,connector_id,operation_key)
    );
    CREATE INDEX IF NOT EXISTS connector_operation_requests_operation ON connector_operation_requests(operation_id);`
  },
  {
    version: 110,
    name: 'private_diagnostic_capture',
    sql: `CREATE TABLE IF NOT EXISTS diagnostic_captures (
      epoch UUID NOT NULL,
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'recording' CHECK(state IN ('recording','stopped','failed')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      stopped_at TIMESTAMPTZ,
      last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
      last_hash TEXT NOT NULL DEFAULT repeat('0',64) CHECK(last_hash ~ '^[a-f0-9]{64}$'),
      stored_bytes BIGINT NOT NULL DEFAULT 0 CHECK(stored_bytes>=0),
      active_segment UUID,
      writer_id TEXT,
      reason TEXT CHECK(reason IN ('record_too_large','storage_limit','write_failed','unsupported_record'))
    );
    CREATE TABLE IF NOT EXISTS diagnostic_capture_records (
      capture_id UUID NOT NULL REFERENCES diagnostic_captures(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK(sequence>0),
      previous_hash TEXT NOT NULL CHECK(previous_hash ~ '^[a-f0-9]{64}$'),
      hash TEXT NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'),
      body_ciphertext JSONB NOT NULL,
      PRIMARY KEY(capture_id,sequence)
    );`
  },
  {
    version: 111,
    name: 'voice_discussion_notes',
    sql: `CREATE TABLE IF NOT EXISTS voice_discussion_notes (
      task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
      ciphertext JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`
  },
  {
    version: 112,
    name: 'owner_password_authentication',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS password_attempts (
        bucket TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL,
        resets_at TIMESTAMPTZ NOT NULL
      );`
  }
] as const;
